import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import env from '../config/env.js';
import { authLimiter } from '../middleware/security.js';
import { validate } from '../middleware/validate.js';
import Department from '../models/Department.js';
import JoinRequest from '../models/JoinRequest.js';
import User from '../models/User.js';
import { arrangeTree, findInvite, syncRoles } from '../services/departments.js';
import { notifyUsers } from '../services/notify.js';
import { badRequest, conflict, notFound } from '../utils/http.js';
import { email, password, phone } from '../utils/schemas.js';

// The public side of the organisation, used before anyone has an account:
//   /invite/:token  the manager or assistant manager accepts the owner's
//                   invitation and creates their account.
//   /:code          anyone with the department's join link asks to join; the
//                   manager or assistant manager approves them.
const router = Router();

const BCRYPT_COST = 12;
const ROLE_NAME = { manager: 'Manager', assistant: 'Assistant Manager' };

const token = z.strictObject({ token: z.string().min(20).max(200) });
const code = z.strictObject({ code: z.string().min(8).max(40).regex(/^[A-Za-z0-9_-]+$/) });
const employeeId = z
  .string()
  .trim()
  .min(2, 'Write your employee ID')
  .max(20)
  .regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and hyphens');
const name = z.string().trim().min(2, 'Write your full name').max(80);

async function openInvite(value) {
  const invite = await findInvite(value);
  if (!invite) throw notFound('This invitation link is not valid. Ask for a new one.');
  if (invite.acceptedAt) throw conflict('This invitation was already used. Sign in instead.');
  if (invite.expiresAt < new Date()) throw conflict('This invitation has expired. Ask for a new one.');
  const department = await Department.findById(invite.department);
  if (!department) throw notFound('That department no longer exists.');
  return { invite, department };
}

async function assertFree({ email: address, employeeId: id }) {
  const upper = id.toUpperCase();
  if (await User.exists({ email: address })) throw conflict('That email already has an account. Sign in instead.');
  if (await User.exists({ employeeId: upper })) throw conflict('That employee ID is already taken.');
  if (await JoinRequest.exists({ status: 'pending', $or: [{ email: address }, { employeeId: upper }] })) {
    throw conflict('A request with that email or employee ID is already waiting for approval.');
  }
}

router.get('/invite/:token', validate({ params: token }), async (req, res) => {
  const { invite, department } = await openInvite(req.valid.params.token);
  res.json({
    company: env.COMPANY_NAME,
    department: department.name,
    role: invite.role,
    roleName: ROLE_NAME[invite.role],
    name: invite.name,
    email: invite.email,
  });
});

router.post(
  '/invite/:token',
  authLimiter,
  validate({ params: token, body: z.strictObject({ name, employeeId, phone: phone.optional(), password }) }),
  async (req, res) => {
    const { invite, department } = await openInvite(req.valid.params.token);
    const body = req.valid.body;
    await assertFree({ email: invite.email, employeeId: body.employeeId });

    const user = await User.create({
      name: body.name,
      email: invite.email,
      employeeId: body.employeeId,
      phone: body.phone,
      designation: invite.designation || ROLE_NAME[invite.role],
      department: department.name,
      // The assistant manager is the department's admin, and the manager has
      // an admin panel too.
      role: 'admin',
      passwordHash: await bcrypt.hash(body.password, BCRYPT_COST),
    });

    const replaced = invite.role === 'manager' ? department.manager : department.admins[0];
    if (invite.role === 'manager') department.manager = user._id;
    else department.admins = [user._id];
    await department.save();
    await syncRoles([replaced]);
    invite.acceptedAt = new Date();
    invite.user = user._id;
    await invite.save();
    await arrangeTree(department);

    res.status(201).json({ email: user.email, department: department.name, role: ROLE_NAME[invite.role] });
  },
);

router.get('/:code', validate({ params: code }), async (req, res) => {
  const department = await Department.findOne({ joinCode: req.valid.params.code });
  if (!department) throw notFound('This join link is not valid. Ask your manager for the current one.');
  res.json({ company: env.COMPANY_NAME, department: department.name, location: department.location });
});

router.post(
  '/:code',
  authLimiter,
  validate({
    params: code,
    body: z.strictObject({
      name,
      email,
      employeeId,
      phone: phone.optional(),
      designation: z.string().trim().max(80).optional(),
      password,
    }),
  }),
  async (req, res) => {
    const department = await Department.findOne({ joinCode: req.valid.params.code });
    if (!department) throw notFound('This join link is not valid. Ask your manager for the current one.');
    const body = req.valid.body;
    if (!body.password.trim()) throw badRequest('Choose a password.');
    await assertFree(body);

    const request = await JoinRequest.create({
      department: department._id,
      name: body.name,
      email: body.email,
      employeeId: body.employeeId,
      phone: body.phone ?? '',
      designation: body.designation ?? '',
      passwordHash: await bcrypt.hash(body.password, BCRYPT_COST),
    });

    res.status(201).json({ department: department.name });

    const approvers = [department.manager, ...department.admins].filter(Boolean);
    await notifyUsers([...new Set(approvers.map(String))], {
      kind: 'request',
      title: `${request.name} asked to join ${department.name}`,
      body: request.designation || 'Waiting for your approval',
      link: `/departments/${department.id}`,
    });
  },
);

export default router;
