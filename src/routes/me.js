import { Router } from 'express';
import { z } from 'zod';
import env from '../config/env.js';
import { validate } from '../middleware/validate.js';
import BalanceAdjustment from '../models/BalanceAdjustment.js';
import Holiday from '../models/Holiday.js';
import Leave, { ACTIVE_STATUSES, LEAVE_STATUSES } from '../models/Leave.js';
import { getBalances, getMonthlyUsage } from '../services/balances.js';
import { isWeekend } from '../services/leaveDays.js';
import { toDayString, todayString, yearRange } from '../utils/dates.js';
import { pageMeta, paginate, toCsv } from '../utils/http.js';
import { idParams, limit, page, year } from '../utils/schemas.js';

const router = Router();

const currentYear = () => Number(todayString(env.TIMEZONE).slice(0, 4));

const reviewerFields = 'name';
const typeFields = 'name code tracksBalance restrictedHolidayOnly';

function leaveEntry(leave) {
  const json = leave.toJSON();
  return {
    kind: 'leave',
    id: json.id,
    from: json.from,
    to: json.to,
    title: leave.leaveType?.name ?? 'Leave',
    typeCode: leave.leaveType?.code,
    days: json.days,
    session: json.session,
    status: json.status,
    reason: json.reason,
  };
}

function holidayEntry(holiday, availedIds, rhAvailable) {
  const json = holiday.toJSON();
  const availed = availedIds.has(json.id);
  return {
    kind: 'holiday',
    id: json.id,
    from: json.date,
    to: json.date,
    title: json.name,
    note: json.note,
    restricted: json.restricted,
    availed,
    // A restricted holiday on a weekly off is already a day off.
    canAvail: json.restricted && !availed && rhAvailable > 0 && !isWeekend(holiday.date),
  };
}

router.get(
  '/summary',
  validate({ query: z.object({ year: year.optional() }) }),
  async (req, res) => {
    const selectedYear = req.valid.query.year ?? currentYear();
    const { start, end } = yearRange(selectedYear);
    const today = todayString(env.TIMEZONE);

    const [balances, leaves, holidays, monthly, adjustments] = await Promise.all([
      getBalances(req.user.id, selectedYear),
      Leave.find({ user: req.user.id, year: selectedYear, status: { $in: ACTIVE_STATUSES } })
        .populate('leaveType', typeFields)
        .sort({ from: 1 }),
      Holiday.find({ date: { $gte: start, $lte: end } }).sort({ date: 1 }),
      getMonthlyUsage(req.user.id, selectedYear),
      BalanceAdjustment.find({ user: req.user.id, year: selectedYear, dismissedAt: null })
        .populate('leaveType', 'name')
        .populate('createdBy', 'name')
        .sort({ updatedAt: -1 }),
    ]);

    const rhBalance = balances.find((balance) => balance.leaveType.restrictedHolidayOnly);
    const availedIds = new Set(leaves.filter((l) => l.holiday).map((l) => String(l.holiday)));

    const entries = [
      ...leaves.map(leaveEntry),
      ...holidays.map((holiday) => holidayEntry(holiday, availedIds, rhBalance?.available ?? 0)),
    ];

    const upcoming = entries
      .filter((entry) => entry.to >= today)
      .sort((a, b) => a.from.localeCompare(b.from));
    const past = entries
      .filter((entry) => entry.to < today)
      .sort((a, b) => b.from.localeCompare(a.from));

    const bookedThisYear = balances.reduce((sum, balance) => sum + balance.booked, 0);
    const absent = balances
      .filter((balance) => !balance.leaveType.tracksBalance)
      .reduce((sum, balance) => sum + balance.earlier + balance.approved, 0);

    res.json({
      year: selectedYear,
      today,
      bookedThisYear,
      absent,
      balances,
      monthly,
      adjustments: adjustments.map((item) => ({
        id: item.id,
        leaveType: item.leaveType?.name,
        days: item.days,
        reason: item.reason,
        by: item.createdBy?.name,
        date: todayString(env.TIMEZONE, item.updatedAt),
      })),
      upcoming,
      past,
      restrictedHolidayTypeId: rhBalance?.leaveType.id ?? null,
    });
  },
);

router.get(
  '/leaves',
  validate({
    query: z.object({
      status: z.enum(LEAVE_STATUSES).optional(),
      year: year.optional(),
      page: page.optional(),
      limit: limit.optional(),
    }),
  }),
  async (req, res) => {
    const { status, year: selectedYear } = req.valid.query;
    const pageInfo = paginate(req.valid.query);

    const filter = { user: req.user.id };
    if (status) filter.status = status;
    if (selectedYear) filter.year = selectedYear;

    const [items, total] = await Promise.all([
      Leave.find(filter)
        .populate('leaveType', typeFields)
        .populate('reviewedBy', reviewerFields)
        .sort({ createdAt: -1 })
        .skip(pageInfo.skip)
        .limit(pageInfo.limit),
      Leave.countDocuments(filter),
    ]);

    res.json({ items, ...pageMeta(total, pageInfo) });
  },
);

router.get(
  '/leaves.csv',
  validate({ query: z.object({ year: year.optional() }) }),
  async (req, res) => {
    const selectedYear = req.valid.query.year ?? currentYear();
    const leaves = await Leave.find({ user: req.user.id, year: selectedYear })
      .populate('leaveType', 'name')
      .sort({ from: 1 });

    const csv = toCsv(
      ['From', 'To', 'Leave type', 'Days', 'Status', 'Reason'],
      leaves.map((leave) => [
        toDayString(leave.from),
        toDayString(leave.to),
        leave.leaveType?.name,
        leave.days,
        leave.status,
        leave.reason,
      ]),
    );

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="my-leave-${selectedYear}.csv"`);
    res.send(`﻿${csv}`);
  },
);

router.patch('/adjustments/:id/dismiss', validate({ params: idParams }), async (req, res) => {
  await BalanceAdjustment.updateOne({ _id: req.valid.params.id, user: req.user.id }, { dismissedAt: new Date() });
  res.status(204).end();
});

export default router;
