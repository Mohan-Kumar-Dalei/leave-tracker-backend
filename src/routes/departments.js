import { Router } from 'express';
import { z } from 'zod';
import env from '../config/env.js';
import { validate } from '../middleware/validate.js';
import Department from '../models/Department.js';
import JoinRequest from '../models/JoinRequest.js';
import OrgInvite from '../models/OrgInvite.js';
import User from '../models/User.js';
import {
  arrangeTree,
  canManage,
  createInvite,
  CASE_INSENSITIVE,
  joinCodeOf,
  leadOf,
  memberFilter,
  reportsToFor,
  syncRoles,
} from '../services/departments.js';
import { createWithNextId } from '../services/employeeIds.js';
import { sendMail } from '../services/mail.js';
import { notifyUsers } from '../services/notify.js';
import { approvedMail, inviteMail, inviteUrl, joinLinkMail, joinUrl } from '../services/orgMail.js';
import { peopleIn } from '../services/scope.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/http.js';
import { email, idParams, objectId } from '../utils/schemas.js';

// A department's own page, for whoever runs it: its manager, its assistant
// manager, and the organisation's owner. From here they share the join link,
// approve the people who ask to join and choose the assistant manager.
const router = Router();

const requestParams = z.strictObject({ id: objectId, requestId: objectId });

async function managed(req, id) {
  const department = await Department.findById(id);
  if (!department) throw notFound('That department was not found.');
  if (!canManage(req.user, department)) throw forbidden('Only this department’s manager or assistant manager can do that.');
  return department;
}

// The departments the signed-in person runs (for their menu).
router.get('/mine', async (req, res) => {
  const id = req.user._id;
  const departments = await Department.find({ $or: [{ manager: id }, { admins: id }] }).sort({ name: 1 });
  res.json({ items: departments.map((department) => ({ id: department.id, name: department.name })) });
});

router.get('/:id', validate({ params: idParams }), async (req, res) => {
  const department = await managed(req, req.valid.params.id);
  const [members, requests, code] = await Promise.all([
    User.find({ ...memberFilter, isActive: true, ...peopleIn([department.name]) })
      .collation(CASE_INSENSITIVE)
      .select('name employeeId email designation avatarUrl reportsTo teamLead')
      .sort({ name: 1 }),
    JoinRequest.find({ department: department._id, status: 'pending' }).sort({ createdAt: 1 }),
    joinCodeOf(department),
  ]);

  const manager = String(department.manager ?? '');
  const lead = String(leadOf(department) ?? '');
  const canChooseAssistant = req.user.role === 'owner' || String(req.user._id) === manager;
  const invited = await OrgInvite.findOne({
    department: department._id,
    role: 'assistant',
    acceptedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  });
  // A team lead is someone made one, or anyone others already report to.
  const reportedTo = new Set(members.map((person) => String(person.reportsTo ?? '')));
  res.json({
    department: {
      id: department.id,
      name: department.name,
      location: department.location,
      managerName: department.managerName,
    },
    you: { canChooseAssistant, canInviteAssistant: canChooseAssistant && !lead },
    assistantInvite: invited ? { name: invited.name, email: invited.email } : null,
    joinLink: joinUrl(code),
    members: members.map((person) => ({
      ...person.toJSON(),
      designation: person.designation || env.DEFAULT_DESIGNATION,
      place: String(person._id) === manager ? 'manager' : String(person._id) === lead ? 'assistant' : 'member',
      teamLead: Boolean(person.teamLead) || reportedTo.has(person.id),
      reportsTo: person.reportsTo ? String(person.reportsTo) : null,
    })),
    requests,
  });
});

// The manager invites their assistant manager by mail; the AM registers with
// the link and becomes the department's admin.
router.post(
  '/:id/assistant-invite',
  validate({
    params: idParams,
    body: z.strictObject({ name: z.string().trim().min(2, 'Write the full name').max(80), email }),
  }),
  async (req, res) => {
    const department = await managed(req, req.valid.params.id);
    if (req.user.role !== 'owner' && String(department.manager ?? '') !== String(req.user._id)) {
      throw forbidden('Only the manager invites the assistant manager.');
    }
    const { name, email: address } = req.valid.body;
    if (await User.exists({ email: address })) throw conflict(`${address} already has an account.`);
    const { invite, token } = await createInvite({
      department,
      role: 'assistant',
      name,
      email: address,
      designation: 'Assistant Manager',
      invitedBy: req.user._id,
    });
    const sent = await sendMail({ to: [address], sender: req.user, ...inviteMail({ invite, department, token, inviter: req.user }) });
    res.status(201).json({ invite: { name, email: address, link: inviteUrl(token), sent } });
  },
);

// A new join link; the old one stops working.
router.post('/:id/join-link', validate({ params: idParams }), async (req, res) => {
  const department = await managed(req, req.valid.params.id);
  res.json({ joinLink: joinUrl(await joinCodeOf(department, { fresh: true })) });
});

// Mails the join link to the team, from the person sending it.
router.post(
  '/:id/join-link/mail',
  validate({ params: idParams, body: z.strictObject({ emails: z.array(email).min(1, 'Add at least one email').max(50) }) }),
  async (req, res) => {
    const department = await managed(req, req.valid.params.id);
    const code = await joinCodeOf(department);
    const emails = [...new Set(req.valid.body.emails)];
    const results = await Promise.all(
      emails.map((address) => sendMail({ to: [address], sender: req.user, ...joinLinkMail({ department, code, sender: req.user }) })),
    );
    res.json({ sent: results.filter(Boolean).length, failed: results.filter((ok) => !ok).length });
  },
);

async function pendingRequest(department, requestId) {
  const request = await JoinRequest.findOne({ _id: requestId, department: department._id }).select('+passwordHash');
  if (!request) throw notFound('That request was not found.');
  if (request.status !== 'pending') throw conflict(`This request is already ${request.status}.`);
  return request;
}

router.post('/:id/requests/:requestId/approve', validate({ params: requestParams }), async (req, res) => {
  const department = await managed(req, req.valid.params.id);
  const request = await pendingRequest(department, req.valid.params.requestId);
  if (await User.exists({ email: request.email })) throw conflict('Someone with that email already has an account.');

  // They get the next employee ID in the company's CON series.
  const user = await createWithNextId({
    name: request.name,
    email: request.email,
    phone: request.phone || undefined,
    designation: request.designation,
    department: department.name,
    role: 'employee',
    reportsTo: reportsToFor(department),
    passwordHash: request.passwordHash,
  });
  request.status = 'approved';
  request.decidedBy = req.user._id;
  request.decidedAt = new Date();
  request.user = user._id;
  request.passwordHash = undefined;
  await request.save();

  res.json({ person: user });
  sendMail({ to: [user.email], sender: req.user, ...approvedMail({ request, department, approver: req.user }) });
});

router.post('/:id/requests/:requestId/reject', validate({ params: requestParams }), async (req, res) => {
  const department = await managed(req, req.valid.params.id);
  const request = await pendingRequest(department, req.valid.params.requestId);
  request.status = 'rejected';
  request.decidedBy = req.user._id;
  request.decidedAt = new Date();
  request.passwordHash = undefined;
  await request.save();
  res.status(204).end();
});

// The manager or the assistant manager arranges the team: makes someone a
// team lead (or not), and picks who each person reports to: the assistant
// manager, the manager, or one of the team leads.
const memberParams = z.strictObject({ id: objectId, userId: objectId });
router.patch(
  '/:id/members/:userId',
  validate({
    params: memberParams,
    body: z.strictObject({ teamLead: z.boolean(), reportsTo: objectId.nullable() }).partial(),
  }),
  async (req, res) => {
    const department = await managed(req, req.valid.params.id);
    const inDepartment = { ...memberFilter, isActive: true, ...peopleIn([department.name]) };
    const person = await User.findOne({ _id: req.valid.params.userId, ...inDepartment }).collation(CASE_INSENSITIVE);
    if (!person) throw notFound(`That person is not in ${department.name}.`);
    const leaders = [department.manager, leadOf(department)].filter(Boolean).map(String);
    if (leaders.includes(person.id)) throw badRequest('The manager and the assistant manager are already above the team.');
    const { teamLead, reportsTo } = req.valid.body;
    const boss = leadOf(department) ?? department.manager ?? null;

    if (teamLead !== undefined) {
      person.teamLead = teamLead;
      // No longer a lead: their team goes back to the assistant manager.
      if (!teamLead) {
        await User.updateMany({ ...inDepartment, reportsTo: person._id }, { $set: { reportsTo: boss } }).collation(
          CASE_INSENSITIVE,
        );
      }
    }
    if (reportsTo !== undefined) {
      const target = reportsTo ? String(reportsTo) : null;
      if (target === person.id) throw badRequest('Someone cannot report to themselves.');
      if (target && !leaders.includes(target)) {
        const lead = await User.findOne({ _id: target, ...inDepartment }).collation(CASE_INSENSITIVE);
        const leadsSomeone = lead && (lead.teamLead || (await User.exists({ ...inDepartment, reportsTo: lead._id })));
        if (!leadsSomeone) throw badRequest('Pick the assistant manager, the manager or a team lead.');
        if (String(lead.reportsTo ?? '') === person.id) throw badRequest(`${lead.name} reports to ${person.name}.`);
      }
      person.reportsTo = target ?? boss;
    }
    await person.save();
    res.json({ person: { id: person.id, teamLead: person.teamLead, reportsTo: person.reportsTo ? String(person.reportsTo) : null } });
  },
);

// The manager (or the owner) chooses the assistant manager from the team.
// The team then reports to them, as in Content Integration.
router.put(
  '/:id/assistant',
  validate({ params: idParams, body: z.strictObject({ user: objectId.nullable() }) }),
  async (req, res) => {
    const department = await managed(req, req.valid.params.id);
    const isManager = String(department.manager ?? '') === String(req.user._id);
    if (req.user.role !== 'owner' && !isManager) throw forbidden('Only the manager can choose the assistant manager.');

    const chosen = req.valid.body.user;
    if (chosen) {
      const person = await User.findOne({ _id: chosen, ...memberFilter, isActive: true, ...peopleIn([department.name]) }).collation(
        CASE_INSENSITIVE,
      );
      if (!person) throw badRequest(`Pick someone in ${department.name}.`);
      if (String(person._id) === String(department.manager)) throw badRequest('The manager cannot also be the assistant manager.');
      if (!person.designation) {
        person.designation = 'Assistant Manager';
        await person.save();
      }
    }
    const previous = department.admins[0];
    department.admins = chosen ? [chosen] : [];
    await department.save();
    await syncRoles([previous, chosen]);
    await arrangeTree(department);
    res.json({ ok: true });

    if (chosen) {
      await notifyUsers([chosen], {
        kind: 'request',
        title: `You are now the assistant manager of ${department.name}`,
        body: 'You can approve people who ask to join the department.',
        link: `/departments/${department.id}`,
      });
    }
  },
);

export default router;
