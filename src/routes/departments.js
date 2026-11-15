import { Router } from 'express';
import { z } from 'zod';
import env from '../config/env.js';
import { validate } from '../middleware/validate.js';
import Department from '../models/Department.js';
import JoinRequest from '../models/JoinRequest.js';
import User from '../models/User.js';
import {
  arrangeTree,
  canManage,
  CASE_INSENSITIVE,
  joinCodeOf,
  leadOf,
  memberFilter,
  reportsToFor,
} from '../services/departments.js';
import { sendMail } from '../services/mail.js';
import { notifyUsers } from '../services/notify.js';
import { approvedMail, joinLinkMail, joinUrl } from '../services/orgMail.js';
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
    User.find({ ...memberFilter, isActive: true, department: department.name })
      .collation(CASE_INSENSITIVE)
      .select('name employeeId email designation avatarUrl reportsTo')
      .sort({ name: 1 }),
    JoinRequest.find({ department: department._id, status: 'pending' }).sort({ createdAt: 1 }),
    joinCodeOf(department),
  ]);

  const manager = String(department.manager ?? '');
  const lead = String(leadOf(department) ?? '');
  res.json({
    department: {
      id: department.id,
      name: department.name,
      location: department.location,
      managerName: department.managerName,
    },
    you: { canChooseAssistant: req.user.role === 'owner' || String(req.user._id) === manager },
    joinLink: joinUrl(code),
    members: members.map((person) => ({
      ...person.toJSON(),
      designation: person.designation || env.DEFAULT_DESIGNATION,
      place: String(person._id) === manager ? 'manager' : String(person._id) === lead ? 'assistant' : 'member',
    })),
    requests,
  });
});

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
  if (await User.exists({ $or: [{ email: request.email }, { employeeId: request.employeeId }] })) {
    throw conflict('Someone with that email or employee ID already has an account.');
  }

  const user = await User.create({
    name: request.name,
    email: request.email,
    employeeId: request.employeeId,
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
      const person = await User.findOne({ _id: chosen, ...memberFilter, isActive: true, department: department.name }).collation(
        CASE_INSENSITIVE,
      );
      if (!person) throw badRequest(`Pick someone in ${department.name}.`);
      if (String(person._id) === String(department.manager)) throw badRequest('The manager cannot also be the assistant manager.');
      if (!person.designation) {
        person.designation = 'Assistant Manager';
        await person.save();
      }
    }
    department.admins = chosen ? [chosen] : [];
    await department.save();
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
