import { Router } from 'express';
import env from '../config/env.js';
import Department from '../models/Department.js';
import Leave from '../models/Leave.js';
import User from '../models/User.js';
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
      .select('name employeeId email phone designation department role avatarUrl reportsTo workFromHome teamLead')
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

export default router;
