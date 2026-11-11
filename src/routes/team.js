import { Router } from 'express';
import env from '../config/env.js';
import Leave from '../models/Leave.js';
import User from '../models/User.js';
import { notHidden } from '../services/hidden.js';
import { parseDay, toDayString, todayString } from '../utils/dates.js';

// The team, for everyone signed in: who is in which department and role, how
// to reach them, and who is on leave today. Only approved leave counts. Leave
// Without Pay is flagged so it can be shown apart from the rest.

const router = Router();

const isUnpaid = (type) => type?.code === 'LWP' || /without pay/i.test(type?.name ?? '');

router.get('/', async (req, res) => {
  const today = todayString(env.TIMEZONE);
  const day = parseDay(today);

  const [people, onLeave] = await Promise.all([
    User.find({ isActive: true, ...notHidden }).select('name employeeId email phone designation department role avatarUrl').sort({ name: 1 }),
    Leave.find({ status: 'approved', from: { $lte: day }, to: { $gte: day } }).populate('leaveType', 'name code'),
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

  const members = people.map((person) => ({
    id: person.id,
    name: person.name,
    employeeId: person.employeeId,
    email: person.email,
    phone: person.phone,
    avatarUrl: person.avatarUrl,
    role: person.role,
    designation: person.designation || (person.role === 'admin' ? 'Admin' : env.DEFAULT_DESIGNATION),
    department: person.department || env.DEFAULT_DEPARTMENT,
    location: env.COMPANY_LOCATION,
    leave: leaveOf.get(person.id) ?? null,
  }));

  res.json({
    today,
    location: env.COMPANY_LOCATION,
    departments: [...new Set(members.map((member) => member.department))].sort(),
    members,
  });
});

export default router;
