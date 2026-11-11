import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import env from '../config/env.js';
import { validate } from '../middleware/validate.js';
import BalanceAdjustment from '../models/BalanceAdjustment.js';
import Holiday from '../models/Holiday.js';
import ImportedUsage from '../models/ImportedUsage.js';
import Leave, { LEAVE_STATUSES } from '../models/Leave.js';
import LeaveType from '../models/LeaveType.js';
import User from '../models/User.js';
import { getBalance, getBalances, getMonthlyUsage } from '../services/balances.js';
import { assessLeave } from '../services/leaves.js';
import { sendMail } from '../services/mail.js';
import { decisionMail, letterCore } from '../services/leaveMail.js';
import { range } from '../services/mailTemplates.js';
import { notHidden, visibleLeaveOwners } from '../services/hidden.js';
import { broadcastChange, getActiveAdmins, notifyUsers } from '../services/notify.js';
import { revokeAllSessions } from '../services/tokens.js';
import { addDays, monthRange, parseDay, toDayString, todayString, yearRange } from '../utils/dates.js';
import {
  ApiError,
  conflict,
  escapeRegex,
  forbidden,
  notFound,
  pageMeta,
  paginate,
  toCsv,
} from '../utils/http.js';
import { day, email, idParams, limit, objectId, page, password, phone, year } from '../utils/schemas.js';

const router = Router();

const BCRYPT_COST = 12;
const employeeFields = 'name email employeeId department designation';
const typeFields = 'name code tracksBalance restrictedHolidayOnly';

/* Overview */

router.get('/overview', async (_req, res) => {
  const todayValue = todayString(env.TIMEZONE);
  const today = parseDay(todayValue);
  const year_ = today.getUTCFullYear();
  const month = monthRange(year_, today.getUTCMonth());

  const owners = await visibleLeaveOwners();
  const [pendingItems, pendingCount, awayToday, nextUp, employees, approvedThisMonth, byType, holidays, earlierYear] =
    await Promise.all([
      Leave.find({ status: 'pending', user: owners })
        .populate('user', employeeFields)
        .populate('leaveType', typeFields)
        .sort({ createdAt: 1 })
        .limit(6),
      Leave.countDocuments({ status: 'pending', user: owners }),
      Leave.find({ status: 'approved', user: owners, from: { $lte: today }, to: { $gte: today } })
        .populate('user', employeeFields)
        .populate('leaveType', typeFields)
        .sort({ to: 1 }),
      Leave.find({ status: 'approved', user: owners, from: { $gt: today, $lte: addDays(today, 14) } })
        .populate('user', employeeFields)
        .populate('leaveType', typeFields)
        .sort({ from: 1 })
        .limit(8),
      User.countDocuments({ isActive: true, role: 'employee', ...notHidden }),
      Leave.aggregate([
        { $match: { status: 'approved', user: owners, from: { $gte: month.start, $lte: month.end } } },
        { $group: { _id: null, days: { $sum: '$days' } } },
      ]),
      Leave.aggregate([
        { $match: { status: 'approved', user: owners, year: year_ } },
        { $group: { _id: '$leaveType', days: { $sum: '$days' }, requests: { $sum: 1 } } },
        { $lookup: { from: 'leavetypes', localField: '_id', foreignField: '_id', as: 'type' } },
        { $unwind: '$type' },
        { $project: { _id: 0, name: '$type.name', code: '$type.code', days: 1, requests: 1, order: '$type.order' } },
        { $sort: { order: 1 } },
      ]),
      Holiday.find({ date: { $gte: today } }).sort({ date: 1 }).limit(3),
      ImportedUsage.aggregate([
        { $match: { year: year_, user: owners } },
        { $lookup: { from: 'leavetypes', localField: 'leaveType', foreignField: '_id', as: 'type' } },
        { $unwind: '$type' },
        {
          $group: {
            _id: { code: '$type.code', name: '$type.name', order: '$type.order' },
            days: { $sum: '$days' },
            thisMonth: { $sum: { $cond: [{ $eq: ['$month', today.getUTCMonth() + 1] }, '$days', 0] } },
          },
        },
      ]),
    ]);

  // Days from the old sheet count alongside days approved here.
  const usage = new Map(byType.map((row) => [row.code, { ...row }]));
  for (const { _id, days } of earlierYear) {
    const row = usage.get(_id.code) ?? { ..._id, days: 0, requests: 0 };
    row.days += days;
    usage.set(_id.code, row);
  }
  const earlierThisMonth = earlierYear.reduce((sum, row) => sum + row.thisMonth, 0);


  res.json({
    today: todayValue,
    pendingCount,
    pending: pendingItems,
    awayToday,
    nextUp,
    employees,
    approvedDaysThisMonth: (approvedThisMonth[0]?.days ?? 0) + earlierThisMonth,
    byType: [...usage.values()].sort((a, b) => a.order - b.order),
    holidays,
  });
});

/* Upcoming and past, for the whole team */

router.get(
  '/schedule',
  validate({ query: z.object({ year: year.optional() }) }),
  async (req, res) => {
    const today = todayString(env.TIMEZONE);
    const selectedYear = req.valid.query.year ?? Number(today.slice(0, 4));
    const { start, end } = yearRange(selectedYear);

    const [leaves, holidays] = await Promise.all([
      Leave.find({ year: selectedYear, status: { $in: ['pending', 'approved'] }, user: await visibleLeaveOwners() })
        .populate('user', 'name')
        .populate('leaveType', 'name'),
      Holiday.find({ date: { $gte: start, $lte: end } }),
    ]);

    const entries = [
      ...leaves.map((leave) => {
        const { id, from, to, days, status, reason } = leave.toJSON();
        return {
          kind: 'leave',
          id,
          from,
          to,
          status,
          title: leave.user?.name,
          detail: `${leave.leaveType?.name}, ${days} ${days === 1 ? 'day' : 'days'}. ${reason}`,
        };
      }),
      ...holidays.map((holiday) => {
        const { id, date, name, note, restricted } = holiday.toJSON();
        return { kind: 'holiday', id, from: date, to: date, title: name, note, restricted };
      }),
    ];

    res.json({
      year: selectedYear,
      upcoming: entries.filter((entry) => entry.to >= today).sort((a, b) => a.from.localeCompare(b.from)),
      past: entries.filter((entry) => entry.to < today).sort((a, b) => b.from.localeCompare(a.from)),
    });
  },
);

/* Leave requests */

const leaveQuery = z.object({
  status: z.enum(LEAVE_STATUSES).optional(),
  user: objectId.optional(),
  leaveType: objectId.optional(),
  from: day.optional(),
  to: day.optional(),
  q: z.string().trim().max(80).optional(),
  page: page.optional(),
  limit: limit.optional(),
});

async function buildLeaveFilter({ status, user, leaveType, from, to, q }) {
  const filter = { user: await visibleLeaveOwners() };
  if (status) filter.status = status;
  if (user) filter.user = { ...filter.user, $eq: user };
  if (leaveType) filter.leaveType = leaveType;
  if (from) filter.to = { $gte: parseDay(from) };
  if (to) filter.from = { $lte: parseDay(to) };

  if (q) {
    const pattern = new RegExp(escapeRegex(q), 'i');
    const people = await User.find({ $or: [{ name: pattern }, { employeeId: pattern }], ...notHidden }).select('_id');
    filter.user = { ...filter.user, $in: people.map((person) => person._id) };
  }
  return filter;
}

router.get('/leaves', validate({ query: leaveQuery }), async (req, res) => {
  const pageInfo = paginate(req.valid.query);
  const filter = await buildLeaveFilter(req.valid.query);

  const [items, total] = await Promise.all([
    Leave.find(filter)
      .populate('user', employeeFields)
      .populate('leaveType', typeFields)
      .populate('reviewedBy', 'name')
      .sort({ createdAt: -1 })
      .skip(pageInfo.skip)
      .limit(pageInfo.limit),
    Leave.countDocuments(filter),
  ]);

  res.json({ items, ...pageMeta(total, pageInfo) });
});

router.get('/leaves.csv', validate({ query: leaveQuery }), async (req, res) => {
  const filter = await buildLeaveFilter(req.valid.query);
  const leaves = await Leave.find(filter)
    .populate('user', employeeFields)
    .populate('leaveType', 'name')
    .populate('reviewedBy', 'name')
    .sort({ from: -1 })
    .limit(10000);

  const csv = toCsv(
    ['Employee ID', 'Employee', 'Department', 'Leave type', 'From', 'To', 'Days', 'Status', 'Reason', 'Decided by', 'Note'],
    leaves.map((leave) => [
      leave.user?.employeeId,
      leave.user?.name,
      leave.user?.department,
      leave.leaveType?.name,
      toDayString(leave.from),
      toDayString(leave.to),
      leave.days,
      leave.status,
      leave.reason,
      leave.reviewedBy?.name,
      leave.reviewNote,
    ]),
  );

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="leave-requests.csv"');
  res.send(`﻿${csv}`);
});

const reviewSchema = z
  .strictObject({
    decision: z.enum(['approved', 'rejected']),
    note: z.string().trim().max(300).optional(),
    // The mail text the admin sends back. Empty means the usual one-line answer.
    reply: z.string().trim().min(5, 'Write a short reply').max(4000, 'Keep the reply under 4000 characters').optional(),
  })
  .refine((body) => body.decision === 'approved' || (body.note?.length ?? 0) >= 3 || body.reply, {
    message: 'Tell the employee why this was rejected.',
    path: ['note'],
  });

router.patch(
  '/leaves/:id/review',
  validate({ params: idParams, body: reviewSchema }),
  async (req, res) => {
    const { decision, reply } = req.valid.body;
    // Without a separate note, the middle of a rejection reply is the reason shown in the app.
    const note = req.valid.body.note || (decision === 'rejected' && reply ? letterCore(reply).slice(0, 300) : '');

    const leave = await Leave.findById(req.valid.params.id)
      .select('+mailMessageId')
      .populate('user', 'name email designation phone role signatureHtml')
      .populate('leaveType', 'name tracksBalance');

    if (!leave) throw notFound('That leave request was not found.');
    if (leave.status !== 'pending') throw conflict(`This request is already ${leave.status}.`);

    if (leave.user.id === req.user.id) {
      const admins = await getActiveAdmins();
      if (admins.length > 1) throw forbidden('Another admin needs to review your own request.');
    }

    if (decision === 'approved' && leave.leaveType.tracksBalance) {
      const balance = await getBalance(leave.user.id, leave.leaveType.id, leave.year);
      if (balance.available < 0) {
        throw conflict(`${leave.user.name} no longer has enough ${leave.leaveType.name} for this request.`);
      }
    }

    // Matching on status means two admins cannot both decide the same request.
    const updated = await Leave.findOneAndUpdate(
      { _id: leave.id, status: 'pending' },
      { status: decision, reviewedBy: req.user.id, reviewedAt: new Date(), reviewNote: note, reply },
      { returnDocument: 'after' },
    )
      .populate('user', employeeFields)
      .populate('leaveType', typeFields)
      .populate('reviewedBy', 'name');

    if (!updated) throw conflict('Another admin just decided this request.');

    res.json({ leave: updated });

    const json = updated.toJSON();
    await notifyUsers([leave.user.id], {
      kind: 'decision',
      title: `Your leave was ${decision}`,
      body: `${leave.leaveType.name}, ${range(json)}${note ? `. ${note}` : ''}`,
      link: '/requests',
    });

    broadcastChange();

    sendMail(
      decisionMail({
        employee: leave.user,
        reviewer: req.user,
        leave: { ...json, mailMessageId: leave.mailMessageId },
        decision,
        reply,
        note,
      }),
    );
  },
);

/* Employees */

const employeeBody = {
  name: z.string().trim().min(2).max(80),
  email,
  employeeId: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and hyphens'),
  role: z.enum(['employee', 'admin']).optional(),
  department: z.string().trim().max(60).optional(),
  designation: z.string().trim().max(80).optional(),
  phone: phone.optional(),
  joinedOn: day.optional(),
  isActive: z.boolean().optional(),
};

router.get(
  '/employees',
  validate({
    query: z.object({
      q: z.string().trim().max(80).optional(),
      status: z.enum(['active', 'inactive', 'all']).optional(),
      page: page.optional(),
      limit: limit.optional(),
    }),
  }),
  async (req, res) => {
    const { q, status = 'active' } = req.valid.query;
    const pageInfo = paginate(req.valid.query);

    // Admins run the system and are not part of the employee list.
    const filter = { role: 'employee', ...notHidden };
    if (status !== 'all') filter.isActive = status === 'active';
    if (q) {
      const pattern = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ name: pattern }, { email: pattern }, { employeeId: pattern }, { department: pattern }];
    }

    const [items, total] = await Promise.all([
      User.find(filter).sort({ name: 1 }).skip(pageInfo.skip).limit(pageInfo.limit),
      User.countDocuments(filter),
    ]);

    res.json({ items, ...pageMeta(total, pageInfo) });
  },
);

// The admin sets the first password and the employee can change it after signing in.
router.post(
  '/employees',
  validate({ body: z.strictObject({ ...employeeBody, password }) }),
  async (req, res) => {
    const { joinedOn, password: chosenPassword, ...rest } = req.valid.body;

    const user = await User.create({
      ...rest,
      joinedOn: joinedOn ? parseDay(joinedOn) : undefined,
      passwordHash: await bcrypt.hash(chosenPassword, BCRYPT_COST),
    });

    res.status(201).json({ user });
  },
);

router.get(
  '/employees/:id',
  validate({ params: idParams, query: z.object({ year: year.optional() }) }),
  async (req, res) => {
    const selectedYear = req.valid.query.year ?? Number(todayString(env.TIMEZONE).slice(0, 4));
    const user = await User.findById(req.valid.params.id);
    if (!user) throw notFound('That employee was not found.');

    const [balances, monthly, adjustments, recent, recorded] = await Promise.all([
      getBalances(user.id, selectedYear),
      getMonthlyUsage(user.id, selectedYear),
      BalanceAdjustment.find({ user: user.id, year: selectedYear })
        .populate('leaveType', 'name')
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 }),
      // Leave in the year: everything approved, applied for or recorded by an admin.
      Leave.find({ user: user.id, year: selectedYear, status: 'approved' })
        .populate('leaveType', typeFields)
        .populate('recordedBy', 'name')
        .sort({ from: -1 })
        .limit(100),
      // Leave an admin recorded with "Adjust balance". It also shows with the
      // balance changes, since it came from there.
      Leave.find({ user: user.id, year: selectedYear, status: 'approved', recordedBy: { $exists: true } })
        .populate('leaveType', typeFields)
        .populate('recordedBy', 'name')
        .sort({ createdAt: -1 }),
    ]);

    res.json({ user, year: selectedYear, balances, monthly, adjustments, recent, recorded });
  },
);

router.patch(
  '/employees/:id',
  validate({ params: idParams, body: z.strictObject(employeeBody).partial() }),
  async (req, res) => {
    const { joinedOn, ...rest } = req.valid.body;
    const target = await User.findById(req.valid.params.id);
    if (!target) throw notFound('That employee was not found.');

    const losingAdmin =
      target.role === 'admin' && (rest.role === 'employee' || rest.isActive === false);

    if (losingAdmin) {
      if (target.id === req.user.id) throw conflict('You cannot remove your own admin access.');
      const admins = await getActiveAdmins();
      if (admins.length <= 1) throw conflict('Keep at least one active admin.');
    }

    Object.assign(target, rest);
    if (joinedOn) target.joinedOn = parseDay(joinedOn);
    await target.save();

    if (rest.isActive === false) await revokeAllSessions(target._id);

    res.json({ user: target });
  },
);

const adjustmentDays = z.coerce
  .number()
  .min(-365)
  .max(365)
  .refine((value) => value !== 0 && Number.isInteger(value * 2), 'Use whole or half days');

const adjustmentReason = z.string().trim().min(3, 'Add a short reason').max(240);

const adjustmentParams = z.strictObject({ id: objectId, adjustmentId: objectId });

const signedDays = (days) => `${days > 0 ? '+' : ''}${days} ${Math.abs(days) === 1 ? 'day' : 'days'}`;

// A change must not take away days the employee has already booked.
async function assertDaysAreFree(userId, leaveType, selectedYear, change) {
  if (change >= 0) return;
  const { available } = await getBalance(userId, leaveType._id, selectedYear);
  if (available + change < 0) {
    throw conflict(`Only ${available} of ${leaveType.name} is free. The rest is already booked, so cancel that leave first.`);
  }
}

async function findAdjustment({ id, adjustmentId }) {
  const adjustment = await BalanceAdjustment.findOne({ _id: adjustmentId, user: id }).populate('leaveType');
  if (!adjustment) throw notFound('That balance change was not found.');
  return adjustment;
}

router.patch(
  '/employees/:id/adjustments/:adjustmentId',
  validate({ params: adjustmentParams, body: z.strictObject({ days: adjustmentDays, reason: adjustmentReason }) }),
  async (req, res) => {
    const { days, reason } = req.valid.body;
    const adjustment = await findAdjustment(req.valid.params);
    const { leaveType, year: adjustmentYear } = adjustment;

    await assertDaysAreFree(adjustment.user, leaveType, adjustmentYear, days - adjustment.days);

    adjustment.days = days;
    adjustment.reason = reason;
    // The employee should see the new version, even if they closed the old one.
    adjustment.dismissedAt = undefined;
    await adjustment.save();

    res.json({ adjustment });

    await notifyUsers([adjustment.user], {
      kind: 'balance',
      title: `${leaveType.name} change updated to ${signedDays(days)}`,
      body: reason,
      link: '/',
    });
    broadcastChange();
  },
);

router.delete(
  '/employees/:id/adjustments/:adjustmentId',
  validate({ params: adjustmentParams }),
  async (req, res) => {
    const adjustment = await findAdjustment(req.valid.params);
    const { leaveType, year: adjustmentYear, days, user } = adjustment;

    await assertDaysAreFree(user, leaveType, adjustmentYear, -days);
    await adjustment.deleteOne();

    res.status(204).end();

    await notifyUsers([user], {
      kind: 'balance',
      title: `${leaveType.name} change of ${signedDays(days)} removed`,
      body: 'Your balance is back to what it was before this change.',
      link: '/',
    });
    broadcastChange();
  },
);

// A leave the employee took but never applied for. The admin picks the days,
// one or several, and for a single day whether it was full or half; it is
// saved as an approved leave, so it comes off what is available and shows on
// the right dates everywhere. The same checks as applying hold: Sundays and
// holidays are not counted, no overlap, and enough balance.
const recordedLeave = z.strictObject({
  leaveTypeId: objectId,
  from: day,
  to: day,
  session: z.enum(['full', 'first', 'second']).default('full'),
  note: z.string().trim().max(300).optional(),
});

async function employeeOr404(id) {
  const user = await User.findById(id);
  if (!user) throw notFound('That employee was not found.');
  return user;
}

// How many days the range counts and what would be left, before saving.
router.post(
  '/employees/:id/leaves/preview',
  validate({ params: idParams, body: recordedLeave.omit({ note: true }) }),
  async (req, res) => {
    const user = await employeeOr404(req.valid.params.id);
    const { days, balance, leaveType } = await assessLeave(user, req.valid.body, { forAdmin: true });
    res.json({
      days,
      tracksBalance: leaveType.tracksBalance,
      availableAfter: leaveType.tracksBalance ? balance.available - days : null,
    });
  },
);

router.post(
  '/employees/:id/leaves',
  validate({ params: idParams, body: recordedLeave }),
  async (req, res) => {
    const { leaveTypeId, from, to, session, note } = req.valid.body;
    const user = await employeeOr404(req.valid.params.id);

    const assessed = await assessLeave(user, { leaveTypeId, from, to, session }, { forAdmin: true });
    const leave = await Leave.create({
      user: user.id,
      leaveType: assessed.leaveType.id,
      holiday: assessed.holiday?.id,
      from: assessed.from,
      to: assessed.to,
      session: assessed.session,
      days: assessed.days,
      year: assessed.year,
      reason: note || 'Recorded by admin',
      status: 'approved',
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
      reviewNote: 'Recorded by admin',
      recordedBy: req.user.id,
    });

    res.status(201).json({ leave });

    const days = `${assessed.days} ${assessed.days === 1 ? 'day' : 'days'}`;
    await notifyUsers([user.id], {
      kind: 'decision',
      title: `Your admin recorded ${days} of leave`,
      body: `${assessed.leaveType.name}, ${range(leave.toJSON())}`,
      link: '/requests',
    });
    broadcastChange();
  },
);

// Takes back a leave an admin recorded by mistake. It is kept as cancelled, so
// the history stays, and the days go back to the balance. Leave the person
// applied for themselves is not touched here.
router.delete(
  '/employees/:id/leaves/:leaveId',
  validate({ params: z.object({ id: objectId, leaveId: objectId }) }),
  async (req, res) => {
    const { id, leaveId } = req.valid.params;
    const leave = await Leave.findOneAndUpdate(
      { _id: leaveId, user: id, status: 'approved', recordedBy: { $exists: true } },
      { status: 'cancelled', cancelledBy: req.user.id, cancelledAt: new Date() },
      { new: true },
    ).populate('leaveType', 'name');
    if (!leave) throw notFound('That recorded leave was not found.');

    res.status(204).end();

    const days = `${leave.days} ${leave.days === 1 ? 'day' : 'days'}`;
    await notifyUsers([id], {
      kind: 'decision',
      title: `Your admin removed ${days} of recorded leave`,
      body: `${leave.leaveType?.name}, ${range(leave.toJSON())}. The days are back in your balance.`,
      link: '/requests',
    });
    broadcastChange();
  },
);

router.post(
  '/employees/:id/adjustments',
  validate({
    params: idParams,
    body: z.strictObject({ leaveTypeId: objectId, year, days: adjustmentDays, reason: adjustmentReason }),
  }),
  async (req, res) => {
    const { leaveTypeId, year: selectedYear, days, reason } = req.valid.body;

    const [user, leaveType] = await Promise.all([
      User.findById(req.valid.params.id),
      LeaveType.findById(leaveTypeId),
    ]);
    if (!user) throw notFound('That employee was not found.');
    if (!leaveType) throw notFound('That leave type was not found.');
    if (!leaveType.tracksBalance) {
      throw new ApiError(400, `${leaveType.name} has no balance to adjust.`);
    }

    await assertDaysAreFree(user.id, leaveType, selectedYear, days);

    const adjustment = await BalanceAdjustment.create({
      user: user.id,
      leaveType: leaveType.id,
      year: selectedYear,
      days,
      reason,
      createdBy: req.user.id,
    });

    res.status(201).json({ adjustment });

    await notifyUsers([user.id], {
      kind: 'balance',
      title: `${leaveType.name} ${days > 0 ? 'credited' : 'reduced'} by ${Math.abs(days)}`,
      body: reason,
      link: '/',
    });
    broadcastChange();
  },
);

export default router;
