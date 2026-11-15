import crypto from 'node:crypto';
import env from '../config/env.js';
import Department from '../models/Department.js';
import OrgInvite from '../models/OrgInvite.js';
import User from '../models/User.js';
import { randomToken, sha256 } from './tokens.js';

// People who belong to departments: everyone but the owner and the hidden
// test accounts.
export const memberFilter = { role: { $ne: 'owner' }, hidden: { $ne: true } };

export const CASE_INSENSITIVE = { locale: 'en', strength: 2 };

const INVITE_DAYS = 14;

// Makes sure every department someone already belongs to exists as a
// Department, so the organisation starts from the people already here.
// People with no department are put in the default one, which is where the
// app already showed them.
export async function syncDepartments() {
  await User.updateMany(
    { ...memberFilter, $or: [{ department: { $exists: false } }, { department: '' }, { department: null }] },
    { $set: { department: env.DEFAULT_DEPARTMENT } },
  );

  const names = (await User.distinct('department', memberFilter)).filter(Boolean);
  const existing = await Department.find({}).collation(CASE_INSENSITIVE).select('name');
  const known = new Set(existing.map((department) => department.name.toLowerCase()));

  for (const name of names) {
    if (known.has(name.toLowerCase())) continue;
    await Department.create({ name, location: env.COMPANY_LOCATION }).catch((error) => {
      if (error?.code !== 11000) throw error; // made by a request at the same moment
    });
    known.add(name.toLowerCase());
  }

  // A department with nobody running it yet takes its existing admin as the
  // assistant manager (as Mrutyunjaya Sahu runs Content Integration), so
  // leave keeps going to the same person after the merge.
  const unrun = await Department.find({ admins: { $size: 0 }, manager: null });
  for (const department of unrun) {
    const admin = await User.findOne({ ...memberFilter, role: 'admin', isActive: true, department: department.name })
      .collation(CASE_INSENSITIVE)
      .sort({ createdAt: 1 });
    if (admin) await Department.updateOne({ _id: department._id }, { $set: { admins: [admin._id] } });
  }

  // Whoever runs a department (its manager or assistant manager) is an admin.
  const leaders = await Department.find({}).select('manager admins');
  const ids = leaders.flatMap((department) => [department.manager, ...department.admins]).filter(Boolean);
  if (ids.length) await User.updateMany({ _id: { $in: ids }, role: 'employee' }, { $set: { role: 'admin' } });
}

// Managers and assistant managers have the admin role; someone who no longer
// runs any department goes back to being an employee. The owner is left alone.
export async function syncRoles(ids) {
  for (const value of ids.filter(Boolean).map(String)) {
    const runs = await Department.exists({ $or: [{ manager: value }, { admins: value }] });
    await User.updateOne(
      { _id: value, role: { $ne: 'owner' } },
      { $set: { role: runs ? 'admin' : 'employee' } },
    );
  }
}

// A department by name, ignoring letter case.
export function findByName(name) {
  return Department.findOne({ name }).collation(CASE_INSENSITIVE);
}

export const leadOf = (department) => department.admins?.[0] ?? null;

// The owner, the department's manager and its assistant manager may run it.
export function canManage(user, department) {
  if (user.role === 'owner') return true;
  const id = String(user._id ?? user.id);
  return String(department.manager ?? '') === id || (department.admins ?? []).some((admin) => String(admin) === id);
}

// A fresh one-time invitation for the manager or assistant manager. An older
// invitation for the same place stops working.
export async function createInvite({ department, role, name, email, designation = '', invitedBy }) {
  await OrgInvite.deleteMany({ department: department._id, role, acceptedAt: { $exists: false } });
  const token = randomToken();
  const invite = await OrgInvite.create({
    department: department._id,
    role,
    name,
    email,
    designation,
    tokenHash: sha256(token),
    invitedBy,
    expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
  });
  return { invite, token };
}

export function findInvite(token) {
  return OrgInvite.findOne({ tokenHash: sha256(String(token)) });
}

// The code in the department's join link, made the first time it is needed.
export async function joinCodeOf(department, { fresh = false } = {}) {
  const current = await Department.findById(department._id).select('+joinCode');
  if (current.joinCode && !fresh) return current.joinCode;
  const code = crypto.randomBytes(9).toString('base64url');
  await Department.updateOne({ _id: department._id }, { $set: { joinCode: code } });
  return code;
}

// Who someone new in the department reports to: the assistant manager, or the
// manager when there is none yet.
export const reportsToFor = (department) => leadOf(department) ?? department.manager ?? null;

// Lays out the department like Content Integration: the assistant manager
// reports to the manager, and everyone without a manager of their own reports
// to the assistant manager (or the manager). People already placed under a
// team lead stay where they are.
export async function arrangeTree(department) {
  const lead = leadOf(department);
  const top = department.manager;
  if (lead && top && String(lead) !== String(top)) {
    await User.updateOne({ _id: lead }, { $set: { reportsTo: top } });
  }
  const boss = lead ?? top;
  if (!boss) return;
  const leaders = [lead, top].filter(Boolean).map(String);
  await User.updateMany(
    {
      ...memberFilter,
      department: department.name,
      _id: { $nin: leaders },
      $or: [{ reportsTo: null }, { reportsTo: { $exists: false } }, { reportsTo: { $in: leaders } }],
    },
    { $set: { reportsTo: boss } },
  ).collation(CASE_INSENSITIVE);
}
