import env from '../config/env.js';
import Department from '../models/Department.js';
import User from '../models/User.js';
import { hiddenUserIds, notHidden } from './hidden.js';

// Who sees and who approves what, now that the leave tracker runs inside the
// organisation:
//   owner (HR or CEO)   the whole company; approves a manager's leave, and
//                       anyone's when nobody else can.
//   manager             their department(s); approves the assistant manager's
//                       leave, and anyone else's in the department.
//   assistant manager   their department(s); the department's admin, who
//                       approves the employees' leave.
// Managers and assistant managers have the admin role. An admin linked to no
// department (as before the organisation existed) runs their own department.

const CASE_INSENSITIVE = { locale: 'en', strength: 2 };
const id = (value) => String(value?._id ?? value ?? '');

export const isStaff = (user) => user?.role === 'admin' || user?.role === 'owner';

// A person's place, which also names their part of the app's URLs:
// /employee/<id>, /employee/assistantmanager/<id>, /employee/manager/<id>,
// /employee/hr/<id>.
export async function positionOf(user) {
  if (user.role === 'owner') return 'hr';
  if (user.role !== 'admin') return 'employee';
  if (await Department.exists({ manager: user._id })) return 'manager';
  return 'assistantmanager';
}

// The user as the app receives it: their record plus their position.
export async function withPosition(user) {
  return { ...user.toJSON(), position: await positionOf(user) };
}

// The department of a person, as the app shows it (empty means the default).
export const departmentOf = (person) => person?.department || env.DEFAULT_DEPARTMENT;

// The departments a user runs: null for the owner (everything).
export async function scopeOf(user) {
  if (user.role === 'owner') return null;
  if (user.role !== 'admin') return [departmentOf(user)];
  const departments = await Department.find({ $or: [{ manager: user._id }, { admins: user._id }] }).select('name');
  return departments.length ? departments.map((department) => department.name) : [departmentOf(user)];
}

// A User filter for the people in a scope (null means everyone).
export function peopleIn(scope) {
  if (!scope) return {};
  const names = scope.includes(env.DEFAULT_DEPARTMENT) ? [...scope, '', null] : scope;
  return { department: { $in: names } };
}

// A Leave/ImportedUsage `user` condition for the people in a scope.
export async function leaveOwnersIn(scope) {
  if (!scope) return { $nin: await hiddenUserIds() };
  const people = await User.find({ ...peopleIn(scope), ...notHidden }).collation(CASE_INSENSITIVE).select('_id');
  return { $in: people.map((person) => person._id) };
}

export async function inScope(scope, person) {
  if (!scope) return true;
  const name = departmentOf(person).toLowerCase();
  return scope.some((item) => item.toLowerCase() === name);
}

async function departmentRecord(person) {
  return Department.findOne({ name: departmentOf(person) }).collation(CASE_INSENSITIVE);
}

// The people who approve someone's leave, in order of who should:
//   an employee   the department's assistant manager, else its manager
//   the AM        the manager
//   the manager   the owner
// When nobody fits (no one set up yet), the department's admins, then the
// owner, then any admin, so a request never goes nowhere.
export async function reviewersFor(person) {
  const department = await departmentRecord(person);
  const active = (ids) =>
    User.find({ _id: { $in: ids.filter(Boolean) }, isActive: true }).select('name email role designation phone signatureHtml');
  // HR is turned off for now, so nobody above a manager gets requests.
  const owners = async () => [];

  const lead = department?.admins?.[0];
  const manager = department?.manager;
  const me = id(person);

  let picked = [];
  // A manager's request goes above them only, never down to their own team.
  if (me && me === id(manager)) return owners();
  if (me && me === id(lead)) picked = manager ? await active([manager]) : [];
  else picked = await active([lead && id(lead) !== me ? lead : null]);
  if (!picked.length && manager && id(manager) !== me) picked = await active([manager]);
  if (!picked.length) {
    picked = await User.find({
      role: 'admin',
      isActive: true,
      _id: { $ne: person._id ?? person.id },
      ...peopleIn([departmentOf(person)]),
    })
      .collation(CASE_INSENSITIVE)
      .select('name email role');
  }
  if (!picked.length) picked = await owners();
  // Never anyone from another department: with no HR, a manager's request
  // simply has no approver yet.
  return picked;
}

// Whether `reviewer` may decide `person`'s leave: never their own; the owner
// for anyone; otherwise only within their departments, and an assistant
// manager not for their manager.
export async function canReview(reviewer, person) {
  if (id(reviewer) === id(person)) return false;
  if (reviewer.role === 'owner') return true;
  if (reviewer.role !== 'admin') return false;
  if (!(await inScope(await scopeOf(reviewer), person))) return false;
  const department = await departmentRecord(person);
  if (department && id(department.manager) === id(person)) return false; // only the owner decides a manager's leave
  return true;
}
