import { Router } from 'express';
import env from '../config/env.js';
import Department from '../models/Department.js';
import Leave from '../models/Leave.js';
import User from '../models/User.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { getBalances, getMonthlyUsage } from '../services/balances.js';
import { notHidden } from '../services/hidden.js';
import { parseDay, toDayString, todayString } from '../utils/dates.js';

// The team, for everyone signed in: who is in which department and role, how
// to reach them, and who is on leave today. Only approved leave counts. Leave
// Without Pay is flagged so it can be shown apart from the rest.

const router = Router();

// HR (the owner) sits in a department of its own, at the top of every tree.
export const HR_DEPARTMENT = 'HR';

const isUnpaid = (type) => type?.code === 'LWP' || /without pay/i.test(type?.name ?? '');

router.get('/', async (req, res) => {
  const today = todayString(env.TIMEZONE);
  const day = parseDay(today);

  const [people, onLeave, departments] = await Promise.all([
    User.find({ isActive: true, role: { $ne: 'owner' }, ...notHidden })
      .select('name employeeId email phone designation department role avatarUrl reportsTo workFromHome teamLead leaveReportTo')
      .sort({ name: 1 }),
    Leave.find({ status: 'approved', from: { $lte: day }, to: { $gte: day } }).populate('leaveType', 'name code'),
    Department.find().select('name manager admins'),
  ]);

  const leaveOf = new Map(
    onLeave.map((leave) => [
      String(leave.user),
      {
        type: leave.leaveType?.name ?? 'Leave',
        unpaid: isUnpaid(leave.leaveType),
        from: toDayString(leave.from),
        to: toDayString(leave.to),
        session: leave.session,
      },
    ]),
  );

  const members = people.map((person) => {
    const owner = person.role === 'owner';
    return {
      id: person.id,
      name: person.name,
      employeeId: person.employeeId,
      email: person.email,
      phone: person.phone,
      avatarUrl: person.avatarUrl,
      role: person.role,
      designation:
        person.designation || (owner ? 'HR' : person.role === 'admin' ? 'Admin' : env.DEFAULT_DESIGNATION),
      department: owner ? HR_DEPARTMENT : person.department || env.DEFAULT_DEPARTMENT,
      location: env.COMPANY_LOCATION,
      reportsTo: owner || !person.reportsTo ? null : String(person.reportsTo),
      workFromHome: person.workFromHome,
      teamLead: Boolean(person.teamLead),
      leaveReportTo: person.leaveReportTo ? String(person.leaveReportTo) : null,
      leave: leaveOf.get(person.id) ?? null,
      // The departments this person manages; they head each one's tree.
      manages: [],
    };
  });

  const byId = new Map(members.map((member) => [member.id, member]));
  // Someone who reports to a person not in the list (inactive or hidden)
  // loses that link and is placed again below.
  for (const member of members) if (member.reportsTo && !byId.has(member.reportsTo)) member.reportsTo = null;

  // Each department's manager and assistant manager, by department name.
  const heads = new Map();
  for (const department of departments) {
    const manager = byId.get(String(department.manager ?? ''));
    const assistant = byId.get(String(department.admins?.[0] ?? ''));
    heads.set(department.name.toLowerCase(), { manager, assistant });
    if (manager && !manager.manages.includes(department.name)) manager.manages.push(department.name);
  }

  // Who heads the tree: HR at the top, then each department's manager, its
  // assistant manager, and the team. Only people with no one above them are
  // placed; links already set are kept.
  const hr = members.find((member) => member.role === 'owner');
  for (const member of members) {
    if (member.reportsTo || member.role === 'owner') continue;
    const head = heads.get(member.department.toLowerCase()) ?? {};
    const managedHere = member.manages.length > 0;
    const above = managedHere
      ? hr
      : member.id === head.assistant?.id
        ? head.manager ?? hr
        : head.assistant ?? head.manager ?? hr;
    if (above && above.id !== member.id) member.reportsTo = above.id;
  }

  res.json({
    today,
    location: env.COMPANY_LOCATION,
    // HR first, then the departments by name.
    departments: [...new Set(members.flatMap((member) => [member.department, ...member.manages]))].sort(
      (a, b) => Number(b === HR_DEPARTMENT) - Number(a === HR_DEPARTMENT) || a.localeCompare(b),
    ),
    members,
  });
});

// Leave totals: available balance, leave applied this year and leave taken,
// month by month. A manager sees every department and can pick one (or all);
// everyone else sees only their own department. Per-person figures are shown
// to managers and assistant managers only; employees see the totals.
const totalsQuery = z.object({
  department: z.string().trim().max(60).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const sameName = (a = '', b = '') => a.localeCompare(b, 'en', { sensitivity: 'accent' }) === 0;

router.get('/totals', validate({ query: totalsQuery }), async (req, res) => {
  const today = todayString(env.TIMEZONE);
  const year = Number(today.slice(0, 4));
  const month = req.valid.query.month ?? Number(today.slice(5, 7));
  const manager = req.user.role === 'owner' || Boolean(await Department.exists({ manager: req.user._id }));
  const own = req.user.department || env.DEFAULT_DEPARTMENT;

  const everyone = await User.find({ isActive: true, role: { $ne: 'owner' }, ...notHidden })
    .select('name employeeId designation department role')
    .sort({ name: 1 });
  const departmentOfPerson = (person) => person.department || env.DEFAULT_DEPARTMENT;
  const allNames = [...new Set(everyone.map(departmentOfPerson))].sort((a, b) => a.localeCompare(b));
  const departments = manager ? allNames : [own];

  // A manager picks a department or all; anyone else always has their own.
  const wanted = req.valid.query.department;
  const chosen = manager ? (wanted && wanted !== 'all' ? departments.find((name) => sameName(name, wanted)) ?? null : null) : own;
  const people = chosen ? everyone.filter((person) => sameName(departmentOfPerson(person), chosen)) : everyone;

  const figures = await Promise.all(
    people.map(async (person) => {
      const [balances, months] = await Promise.all([getBalances(person.id, year), getMonthlyUsage(person.id, year)]);
      const tracked = balances.filter((row) => row.available !== null);
      return {
        person,
        department: departmentOfPerson(person),
        available: tracked.reduce((sum, row) => sum + row.available, 0),
        applied: tracked.reduce((sum, row) => sum + row.booked, 0),
        months,
      };
    }),
  );

  const addMonths = (list) => list.reduce((sum, item) => sum.map((value, index) => value + item.months[index]), Array(12).fill(0));
  const summarise = (list) => ({
    people: list.length,
    available: list.reduce((sum, item) => sum + item.available, 0),
    applied: list.reduce((sum, item) => sum + item.applied, 0),
    takenInMonth: list.reduce((sum, item) => sum + item.months[month - 1], 0),
  });

  // All departments: a row each. One department: a row per person, for
  // managers and assistant managers only.
  const staff = req.user.role === 'admin' || req.user.role === 'owner';
  let rows = [];
  let rowKind = 'department';
  if (!chosen) {
    rows = departments.map((name) => ({ name, ...summarise(figures.filter((item) => item.department === name)) }));
  } else if (staff) {
    rowKind = 'person';
    rows = figures.map((item) => ({
      name: item.person.name,
      employeeId: item.person.employeeId,
      designation: item.person.designation || (item.person.role === 'admin' ? 'Admin' : env.DEFAULT_DESIGNATION),
      people: 1,
      available: item.available,
      applied: item.applied,
      takenInMonth: item.months[month - 1],
    }));
  }

  res.json({
    year,
    month,
    monthName: MONTHS[month - 1],
    canChooseDepartment: manager,
    departments,
    department: chosen ?? 'all',
    summary: summarise(figures),
    months: addMonths(figures),
    rowKind,
    rows,
  });
});

export default router;
