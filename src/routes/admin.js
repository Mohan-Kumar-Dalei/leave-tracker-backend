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
import { sendMail } from '../services/mail.js';
import { decisionMail, inviteMail, range } from '../services/mailTemplates.js';
import { broadcastChange, getActiveAdmins, notifyUsers } from '../services/notify.js';
import { randomToken, revokeAllSessions, sha256 } from '../services/tokens.js';
import { addDays, monthRange, parseDay, toDayString, todayString } from '../utils/dates.js';
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
import { day, email, idParams, limit, objectId, page, year } from '../utils/schemas.js';

const router = Router();

const INVITE_TTL_MS = 48 * 60 * 60 * 1000;
const employeeFields = 'name email employeeId department designation';
const typeFields = 'name code tracksBalance restrictedHolidayOnly';

/* Overview */

router.get('/overview', async (_req, res) => {
  const todayValue = todayString(env.TIMEZONE);
  const today = parseDay(todayValue);
  const year_ = today.getUTCFullYear();
  const month = monthRange(year_, today.getUTCMonth());

  const [pendingItems, pendingCount, awayToday, nextUp, employees, approvedThisMonth, byType, holidays, earlierYear] =
    await Promise.all([
      Leave.find({ status: 'pending' })
        .populate('user', employeeFields)
        .populate('leaveType', typeFields)
        .sort({ createdAt: 1 })
        .limit(6),
      Leave.countDocuments({ status: 'pending' }),
      Leave.find({ status: 'approved', from: { $lte: today }, to: { $gte: today } })
        .populate('user', employeeFields)
        .populate('leaveType', typeFields)
        .sort({ to: 1 }),
      Leave.find({ status: 'approved', from: { $gt: today, $lte: addDays(today, 14) } })
        .populate('user', employeeFields)
        .populate('leaveType', typeFields)
        .sort({ from: 1 })
        .limit(8),
      User.countDocuments({ isActive: true, role: 'employee' }),
      Leave.aggregate([
        { $match: { status: 'approved', from: { $gte: month.start, $lte: month.end } } },
        { $group: { _id: null, days: { $sum: '$days' } } },
      ]),
      Leave.aggregate([
        { $match: { status: 'approved', year: year_ } },
        { $group: { _id: '$leaveType', days: { $sum: '$days' }, requests: { $sum: 1 } } },
        { $lookup: { from: 'leavetypes', localField: '_id', foreignField: '_id', as: 'type' } },
        { $unwind: '$type' },
        { $project: { _id: 0, name: '$type.name', code: '$type.code', days: 1, requests: 1, order: '$type.order' } },
        { $sort: { order: 1 } },
      ]),
      Holiday.find({ date: { $gte: today } }).sort({ date: 1 }).limit(3),
      ImportedUsage.aggregate([
        { $match: { year: year_ } },
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
  const filter = {};
  if (status) filter.status = status;
  if (user) filter.user = user;
  if (leaveType) filter.leaveType = leaveType;
  if (from) filter.to = { $gte: parseDay(from) };
  if (to) filter.from = { $lte: parseDay(to) };

  if (q) {
    const pattern = new RegExp(escapeRegex(q), 'i');
    const people = await User.find({ $or: [{ name: pattern }, { employeeId: pattern }] }).select('_id');
    filter.user = { $in: people.map((person) => person._id) };
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
  })
  .refine((body) => body.decision === 'approved' || (body.note && body.note.length >= 3), {
    message: 'Tell the employee why this was rejected.',
    path: ['note'],
  });

router.patch(
  '/leaves/:id/review',
  validate({ params: idParams, body: reviewSchema }),
  async (req, res) => {
    const { decision, note = '' } = req.valid.body;

    const leave = await Leave.findById(req.valid.params.id)
      .populate('user', 'name email')
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
      { status: decision, reviewedBy: req.user.id, reviewedAt: new Date(), reviewNote: note },
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

    const admins = await getActiveAdmins();
    broadcastChange([leave.user.id, ...admins.map((admin) => admin.id)]);

    sendMail({
      to: leave.user.email,
      ...decisionMail({
        leave: json,
        typeName: leave.leaveType.name,
        decision,
        reviewerName: req.user.name,
      }),
    });
  },
);

/* Team calendar */

router.get(
  '/calendar',
  validate({ query: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }) }),
  async (req, res) => {
    const [yearPart, monthPart] = req.valid.query.month.split('-').map(Number);
    const { start, end } = monthRange(yearPart, monthPart - 1);

    const [leaves, holidays] = await Promise.all([
      Leave.find({ status: { $in: ['approved', 'pending'] }, from: { $lte: end }, to: { $gte: start } })
        .populate('user', 'name employeeId')
        .populate('leaveType', 'name code'),
      Holiday.find({ date: { $gte: start, $lte: end } }),
    ]);

    res.json({ leaves, holidays });
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
  joinedOn: day.optional(),
  isActive: z.boolean().optional(),
};

async function issueInvite(user) {
  const token = randomToken();
  await User.updateOne(
    { _id: user._id },
    { resetTokenHash: sha256(token), resetTokenExpires: new Date(Date.now() + INVITE_TTL_MS) },
  );
  sendMail({ to: user.email, ...inviteMail({ user, token }) });
}

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

    const filter = {};
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

router.post('/employees', validate({ body: z.strictObject(employeeBody) }), async (req, res) => {
  const { joinedOn, ...rest } = req.valid.body;
  const user = await User.create({ ...rest, joinedOn: joinedOn ? parseDay(joinedOn) : undefined });
  await issueInvite(user);
  res.status(201).json({ user });
});

router.get(
  '/employees/:id',
  validate({ params: idParams, query: z.object({ year: year.optional() }) }),
  async (req, res) => {
    const selectedYear = req.valid.query.year ?? Number(todayString(env.TIMEZONE).slice(0, 4));
    const user = await User.findById(req.valid.params.id);
    if (!user) throw notFound('That employee was not found.');

    const [balances, monthly, adjustments, recent] = await Promise.all([
      getBalances(user.id, selectedYear),
      getMonthlyUsage(user.id, selectedYear),
      BalanceAdjustment.find({ user: user.id, year: selectedYear })
        .populate('leaveType', 'name')
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 }),
      Leave.find({ user: user.id, year: selectedYear })
        .populate('leaveType', typeFields)
        .sort({ from: -1 })
        .limit(20),
    ]);

    res.json({ user, year: selectedYear, balances, monthly, adjustments, recent });
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

router.post('/employees/:id/invite', validate({ params: idParams }), async (req, res) => {
  const user = await User.findOne({ _id: req.valid.params.id, isActive: true });
  if (!user) throw notFound('That employee was not found.');
  await issueInvite(user);
  res.json({ message: `A set password link was sent to ${user.email}.` });
});

router.post(
  '/employees/:id/adjustments',
  validate({
    params: idParams,
    body: z.strictObject({
      leaveTypeId: objectId,
      year,
      days: z.coerce
        .number()
        .min(-365)
        .max(365)
        .refine((value) => value !== 0 && Number.isInteger(value * 2), 'Use whole or half days'),
      reason: z.string().trim().min(3, 'Add a short reason').max(240),
    }),
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
    broadcastChange([user.id]);
  },
);

export default router;
