import { Router } from 'express';
import env from '../config/env.js';
import Department from '../models/Department.js';
import Leave from '../models/Leave.js';
import User from '../models/User.js';
import { getBalances } from '../services/balances.js';
import { notHidden } from '../services/hidden.js';
import { monthRange, parseDay, toDayString, todayString } from '../utils/dates.js';

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

// Leave totals everyone can see, for the whole company and each department
// (managers and assistant managers included): how many days are still
// available, how many were applied for this year, and how many were taken
// this month. Only totals, never one person's figures.
router.get('/totals', async (_req, res) => {
  const today = todayString(env.TIMEZONE);
  const year = Number(today.slice(0, 4));
  const month = monthRange(year, Number(today.slice(5, 7)) - 1);
  const people = await User.find({ isActive: true, role: { $ne: 'owner' }, ...notHidden }).select('department');

  const [perPerson, monthRows] = await Promise.all([
    Promise.all(
      people.map(async (person) => {
        const balances = (await getBalances(person.id, year)).filter((row) => row.available !== null);
        return {
          department: person.department || env.DEFAULT_DEPARTMENT,
          available: balances.reduce((sum, row) => sum + row.available, 0),
          applied: balances.reduce((sum, row) => sum + row.booked, 0),
        };
      }),
    ),
    Leave.aggregate([
      { $match: { status: 'approved', user: { $in: people.map((person) => person._id) }, from: { $gte: month.start, $lte: month.end } } },
      { $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'person' } },
      { $unwind: '$person' },
      { $group: { _id: '$person.department', days: { $sum: '$days' } } },
    ]),
  ]);

  const rows = new Map();
  const rowFor = (name) => {
    if (!rows.has(name)) rows.set(name, { name, people: 0, available: 0, applied: 0, takenThisMonth: 0 });
    return rows.get(name);
  };
  for (const item of perPerson) {
    const row = rowFor(item.department);
    row.people += 1;
    row.available += item.available;
    row.applied += item.applied;
  }
  for (const item of monthRows) rowFor(item._id || env.DEFAULT_DEPARTMENT).takenThisMonth += item.days;

  const departments = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  const sum = (key) => departments.reduce((total, row) => total + row[key], 0);
  res.json({
    year,
    month: parseDay(today).toLocaleString('en-IN', { month: 'long', timeZone: 'UTC' }),
    company: { people: sum('people'), available: sum('available'), applied: sum('applied'), takenThisMonth: sum('takenThisMonth') },
    departments,
  });
});

export default router;
