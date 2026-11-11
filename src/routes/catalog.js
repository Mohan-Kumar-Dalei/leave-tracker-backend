import { Router } from 'express';
import { z } from 'zod';
import env from '../config/env.js';
import { requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import Holiday from '../models/Holiday.js';
import Leave, { ACTIVE_STATUSES } from '../models/Leave.js';
import LeaveType from '../models/LeaveType.js';
import { monthRange, parseDay, todayString, yearRange } from '../utils/dates.js';
import { visibleLeaveOwners } from '../services/hidden.js';
import { conflict, notFound } from '../utils/http.js';
import { day, idParams, year } from '../utils/schemas.js';

const router = Router();

const leaveTypeBody = {
  name: z.string().trim().min(2).max(60),
  code: z.string().trim().min(2).max(10).regex(/^[A-Za-z0-9]+$/, 'Use letters and numbers only'),
  description: z.string().trim().max(240).optional(),
  annualQuota: z.coerce.number().min(0).max(365),
  tracksBalance: z.boolean().optional(),
  restrictedHolidayOnly: z.boolean().optional(),
  order: z.coerce.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional(),
};

router.get('/leave-types', async (req, res) => {
  const filter = req.user.role === 'admin' ? {} : { isActive: true };
  const items = await LeaveType.find(filter).sort({ order: 1, name: 1 });
  res.json({ items });
});

router.post(
  '/leave-types',
  requireAdmin,
  validate({ body: z.strictObject(leaveTypeBody) }),
  async (req, res) => {
    const leaveType = await LeaveType.create(req.valid.body);
    res.status(201).json({ leaveType });
  },
);

router.patch(
  '/leave-types/:id',
  requireAdmin,
  validate({ params: idParams, body: z.strictObject(leaveTypeBody).partial() }),
  async (req, res) => {
    const leaveType = await LeaveType.findByIdAndUpdate(req.valid.params.id, req.valid.body, {
      returnDocument: 'after',
      runValidators: true,
    });
    if (!leaveType) throw notFound('That leave type was not found.');
    res.json({ leaveType });
  },
);

const holidayBody = {
  name: z.string().trim().min(2).max(80),
  date: day,
  restricted: z.boolean().optional(),
  note: z.string().trim().max(200).optional(),
};

router.get(
  '/holidays',
  validate({ query: z.object({ year: year.optional() }) }),
  async (req, res) => {
    const selectedYear = req.valid.query.year ?? Number(todayString(env.TIMEZONE).slice(0, 4));
    const { start, end } = yearRange(selectedYear);
    const items = await Holiday.find({ date: { $gte: start, $lte: end } }).sort({ date: 1 });
    res.json({ items, year: selectedYear });
  },
);

router.post(
  '/holidays',
  requireAdmin,
  validate({ body: z.strictObject(holidayBody) }),
  async (req, res) => {
    const { date, ...rest } = req.valid.body;
    const holiday = await Holiday.create({ ...rest, date: parseDay(date) });
    res.status(201).json({ holiday });
  },
);

router.patch(
  '/holidays/:id',
  requireAdmin,
  validate({ params: idParams, body: z.strictObject(holidayBody).partial() }),
  async (req, res) => {
    const { date, ...rest } = req.valid.body;
    const update = date ? { ...rest, date: parseDay(date) } : rest;
    const holiday = await Holiday.findByIdAndUpdate(req.valid.params.id, update, {
      returnDocument: 'after',
      runValidators: true,
    });
    if (!holiday) throw notFound('That holiday was not found.');
    res.json({ holiday });
  },
);

router.delete('/holidays/:id', requireAdmin, validate({ params: idParams }), async (req, res) => {
  const linked = await Leave.exists({ holiday: req.valid.params.id, status: { $in: ACTIVE_STATUSES } });
  if (linked) throw conflict('Someone has availed this holiday. Cancel that leave first.');

  const holiday = await Holiday.findByIdAndDelete(req.valid.params.id);
  if (!holiday) throw notFound('That holiday was not found.');
  res.status(204).end();
});

// Open to everyone so people can check who is away before applying. Only the
// fields listed here leave the server: colleagues see a name and dates, never a
// reason, and only an admin sees the leave type.
router.get(
  '/team-calendar',
  validate({ query: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }) }),
  async (req, res) => {
    const [yearPart, monthPart] = req.valid.query.month.split('-').map(Number);
    const { start, end } = monthRange(yearPart, monthPart - 1);
    const isAdmin = req.user.role === 'admin';

    const [leaves, holidays] = await Promise.all([
      Leave.find({ status: { $in: ACTIVE_STATUSES }, user: await visibleLeaveOwners(), from: { $lte: end }, to: { $gte: start } })
        .populate('user', 'name')
        .populate('leaveType', 'name')
        .sort({ from: 1 }),
      Holiday.find({ date: { $gte: start, $lte: end } }),
    ]);

    res.json({
      today: todayString(env.TIMEZONE),
      weekendDays: env.weekendDays,
      holidays,
      leaves: leaves.map((leave) => {
        const { id, from, to, session, days, status } = leave.toJSON();
        return {
          id,
          name: leave.user?.name,
          from,
          to,
          session,
          days,
          status,
          ...(isAdmin ? { leaveType: leave.leaveType?.name } : {}),
        };
      }),
    });
  },
);

export default router;
