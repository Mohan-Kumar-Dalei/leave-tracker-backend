import { Router } from 'express';
import env from '../config/env.js';
import Department from '../models/Department.js';
import ImportedUsage from '../models/ImportedUsage.js';
import Leave from '../models/Leave.js';
import LeaveType from '../models/LeaveType.js';
import User from '../models/User.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { getBalances } from '../services/balances.js';
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

  // A department may have several assistant managers. Each sits directly
  // under the department's manager, side by side, even if one was once put
  // under another.
  // An assistant manager: an admin who manages no department, or anyone whose
  // designation says Assistant Manager (some were added as employees).
  const isAssistant = (member) =>
    member.manages.length === 0 && (member.role === 'admin' || /assistant\s*manager/i.test(member.designation ?? ''));
  for (const member of members) {
    if (!isAssistant(member)) continue;
    const above = member.reportsTo ? byId.get(member.reportsTo) : null;
    if (above && isAssistant(above) && above.department.toLowerCase() === member.department.toLowerCase()) {
      member.reportsTo = heads.get(member.department.toLowerCase())?.manager?.id ?? null;
    }
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
      : member.id === head.assistant?.id || isAssistant(member)
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
  // A leave type's code, or 'all'. The tracker sheet counts Casual/Sick leave.
  type: z.string().trim().max(20).optional(),
});
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const sameName = (a = '', b = '') => a.localeCompare(b, 'en', { sensitivity: 'accent' }) === 0;
const DEFAULT_TYPE = 'CLSL';

// Counted the way the team's tracker sheet counts:
//   Leave Availed  leave taken this year: approved here plus the old sheet's
//                  days (pending requests are not taken yet)
//   Leave Balance  what the year gives (quota and any credits) minus availed
//   Jan ... Dec    leave taken each month, by the month it starts in
// A manager sees every department and can pick one (or all); everyone else
// sees only their own department. Person by person for managers and assistant
// managers; employees see the totals.
router.get('/totals', validate({ query: totalsQuery }), async (req, res) => {
  const today = todayString(env.TIMEZONE);
  const year = Number(today.slice(0, 4));
  const month = req.valid.query.month ?? Number(today.slice(5, 7));
  const manager = req.user.role === 'owner' || Boolean(await Department.exists({ manager: req.user._id }));
  const own = req.user.department || env.DEFAULT_DEPARTMENT;

  const types = await LeaveType.find({ isActive: true }).sort({ order: 1, name: 1 });
  const wantedType = req.valid.query.type ?? DEFAULT_TYPE;
  // Casual/Sick leave unless asked otherwise (else the first type with a balance).
  const fallback = types.find((item) => item.code === DEFAULT_TYPE) ?? types.find((item) => item.tracksBalance) ?? null;
  const type = wantedType === 'all' ? null : types.find((item) => item.code === wantedType) ?? fallback;

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
  const ids = people.map((person) => person._id);
  const typeMatch = type ? { leaveType: type._id } : {};

  // Taken per person per month: approved leave here, and the old sheet's days.
  const [approved, imported] = await Promise.all([
    Leave.aggregate([
      { $match: { user: { $in: ids }, year, status: 'approved', ...typeMatch } },
      { $group: { _id: { user: '$user', month: { $month: '$from' } }, days: { $sum: '$days' } } },
    ]),
    ImportedUsage.aggregate([
      { $match: { user: { $in: ids }, year, ...typeMatch } },
      { $group: { _id: { user: '$user', month: '$month' }, days: { $sum: '$days' } } },
    ]),
  ]);
  const monthsOf = new Map(people.map((person) => [person.id, Array(12).fill(0)]));
  for (const row of [...approved, ...imported]) monthsOf.get(String(row._id.user))[row._id.month - 1] += row.days;

  const figures = await Promise.all(
    people.map(async (person) => {
      const months = monthsOf.get(person.id);
      const availed = months.reduce((sum, days) => sum + days, 0);
      // What the year gives: the quota plus credits, for leave that has one.
      const balances = (await getBalances(person.id, year)).filter(
        (row) => row.entitled !== null && (!type || row.leaveType.id === type.id),
      );
      // Each type with a balance: what it gives minus what was taken of it
      // (Leave Without Pay has no balance, so it never lowers one).
      const balance = balances.reduce((sum, row) => sum + row.entitled - row.earlier - row.approved, 0);
      return { person, department: departmentOfPerson(person), availed, balance, months };
    }),
  );

  const addMonths = (list) => list.reduce((sum, item) => sum.map((value, index) => value + item.months[index]), Array(12).fill(0));
  const summarise = (list) => ({
    people: list.length,
    balance: list.reduce((sum, item) => sum + item.balance, 0),
    availed: list.reduce((sum, item) => sum + item.availed, 0),
    takenInMonth: list.reduce((sum, item) => sum + item.months[month - 1], 0),
    months: addMonths(list),
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
      balance: item.balance,
      availed: item.availed,
      takenInMonth: item.months[month - 1],
      months: item.months,
    }));
  }

  const summary = summarise(figures);
  res.json({
    year,
    month,
    monthName: MONTHS[month - 1],
    canChooseDepartment: manager,
    departments,
    department: chosen ?? 'all',
    types: types.map((item) => ({ code: item.code, name: item.name, tracksBalance: item.tracksBalance })),
    type: type ? { code: type.code, name: type.name, tracksBalance: type.tracksBalance } : null,
    summary,
    months: summary.months,
    rowKind,
    rows,
  });
});

export default router;
