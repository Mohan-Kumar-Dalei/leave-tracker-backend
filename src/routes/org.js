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
  CASE_INSENSITIVE,
  createInvite,
  findByName,
  leadOf,
  memberFilter,
  syncDepartments,
} from '../services/departments.js';
import { sendMail } from '../services/mail.js';
import { inviteMail, inviteUrl } from '../services/orgMail.js';
import { todayString } from '../utils/dates.js';
import { badRequest, conflict, notFound } from '../utils/http.js';
import { email, idParams, objectId, phone } from '../utils/schemas.js';

// The organisation, for its owner (the company's HR or CEO), kept simple like
// Zoho: departments, each with a manager and an assistant manager, and the
// employees in them. Adding a department invites its manager by mail; the
// manager then invites the team with the department's join link. This stands
// apart from the leave tracker for now; nothing here changes who approves leave.
const router = Router();

const BCRYPT_COST = 12;
const sameName = (a = '', b = '') => a.localeCompare(b, 'en', { sensitivity: 'accent' }) === 0;

const name = z.string().trim().min(2, 'Write the full name').max(80);
const departmentName = z.string().trim().min(2, 'Use at least 2 letters').max(60, 'Keep the name under 60 letters');
const location = z.string().trim().max(60, 'Keep the location under 60 letters').optional();

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

router.get('/', async (_req, res) => {
  await syncDepartments();
  const [departments, members, invites, waiting] = await Promise.all([
    Department.find({}).sort({ name: 1 }),
    activeMembers(),
    OrgInvite.find({ acceptedAt: { $exists: false }, expiresAt: { $gt: new Date() } }),
    JoinRequest.aggregate([{ $match: { status: 'pending' } }, { $group: { _id: '$department', count: { $sum: 1 } } }]),
  ]);
  // An empty designation shows as the default one, as on the rest of the app.
  const people = members.map((person) => ({
    ...person.toJSON(),
    designation: person.designation || env.DEFAULT_DESIGNATION,
  }));
  const byId = new Map(people.map((person) => [person.id, person]));
  const pendingInvite = (department, role) => {
    const found = invites.find((item) => String(item.department) === department.id && item.role === role);
    return found ? { name: found.name, email: found.email, invitedAt: found.createdAt } : null;
  };

  res.json({
    company: { name: env.COMPANY_NAME, location: env.COMPANY_LOCATION },
    departments: departments.map((department) => {
      const { admins, manager, ...rest } = department.toJSON();
      return {
        ...rest,
        manager: byId.get(String(manager ?? '')) ?? null,
        lead: byId.get(String(admins[0] ?? '')) ?? null,
        invited: { assistant: pendingInvite(department, 'assistant') },
        waiting: waiting.find((row) => String(row._id) === department.id)?.count ?? 0,
        people: people.filter((person) => sameName(person.department, department.name)).length,
      };
    }),
    people,
  });
});

// The four steps of "Add department": its name, the manager's name, the
// assistant manager's name and the assistant manager's email. The invitation
// goes to the assistant manager, the first to register: they run the
// department and bring in the team. The manager is a name on the department.
const newDepartment = z.strictObject({
  name: departmentName,
  location,
  managerName: name.optional(),
  assistantName: name.optional(),
  assistantEmail: email.optional(),
});

router.post('/departments', validate({ body: newDepartment }), async (req, res) => {
  const { name: title, location: where = env.COMPANY_LOCATION, managerName = '', assistantName, assistantEmail } =
    req.valid.body;
  if (await findByName(title)) throw conflict(`There is already a department called ${title}.`);
  if (assistantEmail && !assistantName) throw badRequest("Write the assistant manager's name.");
  if (assistantEmail) await assertNewEmail(assistantEmail);

  const department = await Department.create({ name: title, location: where, managerName });
  const invites = assistantEmail
    ? [await invite({ department, role: 'assistant', name: assistantName, email: assistantEmail, designation: 'Assistant Manager', owner: req.user })]
    : [];
  res.status(201).json({ department, invites });
});

// Sends the assistant manager a new invitation (the old link stops working),
// e.g. when the first one was lost or went to the wrong address.
router.post(
  '/departments/:id/invites',
  validate({ params: idParams, body: z.strictObject({ name, email }) }),
  async (req, res) => {
    const department = await departmentOr404(req.valid.params.id);
    const { name: who, email: address } = req.valid.body;
    await assertNewEmail(address);
    res.status(201).json({
      invite: await invite({ department, role: 'assistant', name: who, email: address, designation: 'Assistant Manager', owner: req.user }),
    });
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
    if (lead !== undefined) {
      await assertPerson(lead);
      department.admins = lead ? [lead] : [];
    }
    if (manager !== undefined) {
      await assertPerson(manager);
      department.manager = manager;
    }
    if (title && title !== department.name) {
      await User.updateMany({ department: department.name }, { $set: { department: title } }, { collation: CASE_INSENSITIVE });
      department.name = title;
    }
    if (where !== undefined) department.location = where;
    await department.save();
    res.json({ department });
  },
);

// Only an empty department can go, so nobody is left without one.
router.delete('/departments/:id', validate({ params: idParams }), async (req, res) => {
  const department = await departmentOr404(req.valid.params.id);
  const count = await User.countDocuments({ ...memberFilter, department: department.name }).collation(CASE_INSENSITIVE);
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

// Adds an employee straight away (for one or two people). The starting
// password follows the company's rule, first name @ year (e.g. Asha@2026).
const newPerson = z.strictObject({
  name,
  email,
  employeeId: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and hyphens'),
  designation: z.string().trim().max(80).optional(),
  phone: phone.optional(),
  department: objectId,
});

router.post('/people', validate({ body: newPerson }), async (req, res) => {
  const { department: departmentId, ...fields } = req.valid.body;
  const department = await departmentOr404(departmentId);
  const clash = await User.findOne({ $or: [{ email: fields.email }, { employeeId: fields.employeeId.toUpperCase() }] });
  if (clash) {
    throw conflict(clash.email === fields.email ? 'Someone already uses that email.' : 'That employee ID is taken.');
  }

  const year = todayString(env.TIMEZONE).slice(0, 4);
  const startingPassword = `${fields.name.split(/\s+/)[0]}@${year}`;
  const person = await User.create({
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
