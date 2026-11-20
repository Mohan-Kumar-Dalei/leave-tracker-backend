import bcrypt from 'bcryptjs';
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
  CASE_INSENSITIVE,
  createInvite,
  findByName,
  leadOf,
  memberFilter,
  syncDepartments,
  syncRoles,
} from '../services/departments.js';
import { createWithNextId } from '../services/employeeIds.js';
import { sendMail } from '../services/mail.js';
import { approvedMail, inviteMail, inviteUrl } from '../services/orgMail.js';
import { departmentOf, peopleIn } from '../services/scope.js';
import { todayString } from '../utils/dates.js';
import { badRequest, conflict, notFound } from '../utils/http.js';
import { email, idParams, objectId, phone } from '../utils/schemas.js';

// The organisation, kept simple like Zoho. A manager runs it for the
// departments they manage (HR, the owner, would see every department): departments, each with a manager and an assistant manager, and the
// employees in them. Adding a department invites its manager by mail; the
// manager then invites the team with the department's join link. This stands
// apart from the leave tracker for now; nothing here changes who approves leave.
const router = Router();

const BCRYPT_COST = 12;
const sameName = (a = '', b = '') => a.localeCompare(b, 'en', { sensitivity: 'accent' }) === 0;

const name = z.string().trim().min(2, 'Write the full name').max(80);
const departmentName = z.string().trim().min(2, 'Use at least 2 letters').max(60, 'Keep the name under 60 letters');
const location = z.string().trim().max(60, 'Keep the location under 60 letters').optional();

const isOwner = (user) => user.role === 'owner';

// With HR turned off, the managers run the organisation together: they see
// every department and employee, set who manages and assists each
// department, and approve new managers.
async function departmentOr404(id) {
  const department = await Department.findById(id);
  if (!department) throw notFound('That department was not found.');
  return department;
}

function activeMembers(extra = {}) {
  return User.find({ ...memberFilter, isActive: true, ...extra })
    .select('name employeeId email designation department avatarUrl reportsTo')
    .sort({ name: 1 });
}

async function assertPerson(id) {
  if (!id) return;
  const found = await activeMembers({ _id: id });
  if (!found.length) throw badRequest('That person was not found.');
}

// An address that already has an account cannot be invited to make a new one.
async function assertNewEmail(address) {
  if (await User.exists({ email: address })) throw conflict(`${address} already has an account.`);
}

// Sends the owner's invitation and returns where it points, so the owner can
// also copy the link (useful while mail is not set up).
async function invite({ department, role, name: who, email: address, designation, owner }) {
  const { invite: saved, token } = await createInvite({
    department,
    role,
    name: who,
    email: address,
    designation,
    invitedBy: owner._id,
  });
  const sent = await sendMail({ to: [address], sender: owner, ...inviteMail({ invite: saved, department, token, inviter: owner }) });
  return { role, name: who, email: address, link: inviteUrl(token), sent };
}

router.get('/', async (req, res) => {
  const owner = isOwner(req.user);
  await syncDepartments();
  const [departments, members, invites, waiting, managerRequests] = await Promise.all([
    Department.find({}).sort({ name: 1 }),
    activeMembers(),
    OrgInvite.find({ acceptedAt: { $exists: false }, expiresAt: { $gt: new Date() } }),
    JoinRequest.aggregate([
      { $match: { status: 'pending', kind: { $ne: 'manager' } } },
      { $group: { _id: '$department', count: { $sum: 1 } } },
    ]),
    JoinRequest.find({ kind: 'manager', status: 'pending' }).sort({ createdAt: 1 }),
  ]);
  // An empty designation shows as the default one, as on the rest of the app.
  const people = members.map((person) => ({
    ...person.toJSON(),
    designation: person.designation || env.DEFAULT_DESIGNATION,
    department: departmentOf(person),
  }));
  const byId = new Map(people.map((person) => [person.id, person]));
  const pendingInvite = (department, role) => {
    const found = invites.find((item) => String(item.department) === department.id && item.role === role);
    return found ? { name: found.name, email: found.email, invitedAt: found.createdAt } : null;
  };

  // Every assistant manager a department has: the ones set on it, then anyone
  // else there who is an admin or has the Assistant Manager designation (some
  // were added as employees). Managers of any department are not counted.
  const managerIds = new Set(departments.map((department) => String(department.manager ?? '')));
  const assistantsOf = (department) => {
    const set = department.admins.map((id) => byId.get(String(id))).filter(Boolean);
    const others = people.filter(
      (person) =>
        sameName(person.department, department.name) &&
        !managerIds.has(person.id) &&
        !set.some((item) => item.id === person.id) &&
        (person.role === 'admin' || /assistant\s*manager/i.test(person.designation ?? '')),
    );
    return [...set, ...others].filter((person) => !managerIds.has(person.id));
  };

  res.json({
    company: { name: env.COMPANY_NAME, location: env.COMPANY_LOCATION },
    // A manager adds departments that they run themselves.
    you: { owner, name: req.user.name, id: req.user.id },
    departments: departments.map((department) => {
      const { admins, manager, ...rest } = department.toJSON();
      const assistants = assistantsOf(department);
      return {
        ...rest,
        manager: byId.get(String(manager ?? '')) ?? null,
        lead: byId.get(String(admins[0] ?? '')) ?? null,
        assistants,
        invited: { manager: pendingInvite(department, 'manager'), assistant: pendingInvite(department, 'assistant') },
        waiting: waiting.find((row) => String(row._id) === department.id)?.count ?? 0,
        people: people.filter((person) => sameName(person.department, department.name)).length,
      };
    }),
    people,
    // Managers who registered with a new department, waiting for HR.
    managerRequests,
  });
});

/* Managers who registered on their own */

async function pendingManagerRequest(id) {
  const request = await JoinRequest.findOne({ _id: id, kind: 'manager' }).select('+passwordHash');
  if (!request) throw notFound('That request was not found.');
  if (request.status !== 'pending') throw conflict(`This request is already ${request.status}.`);
  return request;
}

// Approving sets up the department with them as its manager (an admin).
// They then invite their assistant manager from My department.
router.post('/manager-requests/:id/approve', validate({ params: idParams }), async (req, res) => {
  const request = await pendingManagerRequest(req.valid.params.id);
  // A department that exists without a manager (like Content Integration)
  // gets this person as its manager; one with a manager cannot be taken.
  const existing = await findByName(request.departmentName);
  if (existing?.manager) throw conflict(`${existing.name} already has a manager.`);
  if (await User.exists({ email: request.email })) throw conflict('Someone with that email already has an account.');

  const user = await createWithNextId({
    name: request.name,
    email: request.email,
    phone: request.phone || undefined,
    designation: 'Manager',
    department: existing?.name ?? request.departmentName,
    role: 'admin',
    passwordHash: request.passwordHash,
  });
  let department = existing;
  if (department) {
    department.manager = user._id;
    department.managerName = request.name;
    await department.save();
  } else {
    department = await Department.create({
      name: request.departmentName,
      location: request.location || env.COMPANY_LOCATION,
      managerName: request.name,
      manager: user._id,
    });
  }
  await arrangeTree(department);
  request.status = 'approved';
  request.decidedBy = req.user._id;
  request.decidedAt = new Date();
  request.user = user._id;
  request.department = department._id;
  request.passwordHash = undefined;
  await request.save();

  res.json({ department, person: user });
  sendMail({ to: [user.email], sender: req.user, ...approvedMail({ request, department, approver: req.user }) });
});

router.post('/manager-requests/:id/reject', validate({ params: idParams }), async (req, res) => {
  const request = await pendingManagerRequest(req.valid.params.id);
  request.status = 'rejected';
  request.decidedBy = req.user._id;
  request.decidedAt = new Date();
  request.passwordHash = undefined;
  await request.save();
  res.status(204).end();
});

// The four steps of "Add department": its name, the manager (name, and an
// email to invite them), the assistant manager's name and the assistant
// manager's email. The assistant manager, who usually registers first, is the
// department's admin and brings in the team; the manager gets an admin panel
// too and approves the assistant manager's leave.
const newDepartment = z.strictObject({
  name: departmentName,
  location,
  managerName: name.optional(),
  managerEmail: email.optional(),
  assistantName: name.optional(),
  assistantEmail: email.optional(),
});

router.post('/departments', validate({ body: newDepartment }), async (req, res) => {
  const { name: title, location: where = env.COMPANY_LOCATION, assistantName, assistantEmail } = req.valid.body;
  // A manager's new department is theirs to run; only the owner names
  // and invites another manager.
  const owner = isOwner(req.user);
  const managerName = owner ? req.valid.body.managerName ?? '' : req.user.name;
  const managerEmail = owner ? req.valid.body.managerEmail : undefined;
  if (await findByName(title)) throw conflict(`There is already a department called ${title}.`);
  if (assistantEmail && !assistantName) throw badRequest("Write the assistant manager's name.");
  if (managerEmail && !managerName) throw badRequest("Write the manager's name.");
  if (managerEmail && managerEmail === assistantEmail) {
    throw badRequest('The manager and the assistant manager need different emails.');
  }
  if (assistantEmail) await assertNewEmail(assistantEmail);
  if (managerEmail) await assertNewEmail(managerEmail);

  const department = await Department.create({
    name: title,
    location: where,
    managerName,
    ...(owner ? {} : { manager: req.user._id }),
  });
  const invites = [];
  if (assistantEmail) {
    invites.push(await invite({ department, role: 'assistant', name: assistantName, email: assistantEmail, designation: 'Assistant Manager', owner: req.user }));
  }
  if (managerEmail) {
    invites.push(await invite({ department, role: 'manager', name: managerName, email: managerEmail, designation: 'Manager', owner: req.user }));
  }
  res.status(201).json({ department, invites });
});

// Sends a new invitation (the old link stops working), e.g. when the first
// one was lost or went to the wrong address, or to invite the manager later.
router.post(
  '/departments/:id/invites',
  validate({
    params: idParams,
    body: z.strictObject({ role: z.enum(['assistant', 'manager']).default('assistant'), name, email }),
  }),
  async (req, res) => {
    const department = await departmentOr404(req.valid.params.id);
    const { role, name: who, email: address } = req.valid.body;
    await assertNewEmail(address);
    const designation = role === 'manager' ? 'Manager' : 'Assistant Manager';
    if (role === 'manager') department.managerName = who;
    await department.save();
    res.status(201).json({ invite: await invite({ department, role, name: who, email: address, designation, owner: req.user }) });
  },
);

// Renaming moves everyone in the department to the new name. `lead` is the
// assistant manager, chosen from people already here; `managerName` is the
// manager's name.
router.patch(
  '/departments/:id',
  validate({
    params: idParams,
    body: z
      .strictObject({
        name: departmentName,
        location,
        lead: objectId.nullable(),
        manager: objectId.nullable(),
        managerName: z.string().trim().max(80),
      })
      .partial(),
  }),
  async (req, res) => {
    const department = await departmentOr404(req.valid.params.id);
    const { name: title, location: where, lead, manager, managerName } = req.valid.body;
    if (managerName !== undefined) department.managerName = managerName;

    if (title && !sameName(title, department.name)) {
      const clash = await findByName(title);
      if (clash && clash.id !== department.id) throw conflict(`There is already a department called ${title}.`);
    }
    // People whose admin role may change: the old and new manager and AM.
    const touched = [];
    if (lead !== undefined) {
      await assertPerson(lead);
      if (lead && String(lead) === String(manager ?? department.manager ?? '')) {
        throw badRequest('The manager cannot also be the assistant manager.');
      }
      touched.push(department.admins[0], lead);
      department.admins = lead ? [lead] : [];
    }
    if (manager !== undefined) {
      await assertPerson(manager);
      touched.push(department.manager, manager);
      department.manager = manager;
      if (manager) department.managerName = (await User.findById(manager).select('name'))?.name ?? department.managerName;
    }
    if (title && title !== department.name) {
      await User.updateMany({ department: department.name }, { $set: { department: title } }, { collation: CASE_INSENSITIVE });
      department.name = title;
    }
    if (where !== undefined) department.location = where;
    await department.save();
    await syncRoles(touched);
    // The assistant manager reports to the manager, the team to the AM.
    if (manager !== undefined || lead !== undefined) await arrangeTree(department);
    res.json({ department });
  },
);

// Only an empty department can go, so nobody is left without one.
router.delete('/departments/:id', validate({ params: idParams }), async (req, res) => {
  const department = await departmentOr404(req.valid.params.id);
  const count = await User.countDocuments({ ...memberFilter, ...peopleIn([department.name]) }).collation(CASE_INSENSITIVE);
  if (count > 0) {
    throw conflict(`${department.name} still has ${count} ${count === 1 ? 'employee' : 'employees'}. Move them first.`);
  }
  await Promise.all([
    OrgInvite.deleteMany({ department: department._id }),
    JoinRequest.deleteMany({ department: department._id }),
    department.deleteOne(),
  ]);
  res.status(204).end();
});

// Adds an employee straight away (for one or two people). They get the next
// employee ID in the CON series, and the starting password follows the
// company's rule, first name @ year (e.g. Asha@2026).
const newPerson = z.strictObject({
  name,
  email,
  designation: z.string().trim().max(80).optional(),
  phone: phone.optional(),
  department: objectId,
});

router.post('/people', validate({ body: newPerson }), async (req, res) => {
  const { department: departmentId, ...fields } = req.valid.body;
  const department = await departmentOr404(departmentId);
  if (await User.exists({ email: fields.email })) throw conflict('Someone already uses that email.');

  const year = todayString(env.TIMEZONE).slice(0, 4);
  const startingPassword = `${fields.name.split(/\s+/)[0]}@${year}`;
  const person = await createWithNextId({
    ...fields,
    department: department.name,
    role: 'employee',
    reportsTo: leadOf(department) ?? department.manager ?? null,
    passwordHash: await bcrypt.hash(startingPassword, BCRYPT_COST),
  });
  res.status(201).json({ person, startingPassword });
});

// Puts an employee in another department.
router.patch(
  '/people/:id',
  validate({ params: idParams, body: z.strictObject({ department: objectId }) }),
  async (req, res) => {
    const department = await departmentOr404(req.valid.body.department);
    const [person] = await activeMembers({ _id: req.valid.params.id });
    if (!person) throw notFound('That employee was not found.');
    await User.updateOne({ _id: person._id }, { $set: { department: department.name } });
    res.json({ person: { ...person.toJSON(), department: department.name } });
  },
);

export default router;
