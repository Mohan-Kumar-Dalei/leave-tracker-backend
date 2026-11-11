import mongoose from 'mongoose';
import BalanceAdjustment from '../models/BalanceAdjustment.js';
import ImportedUsage from '../models/ImportedUsage.js';
import Leave, { ACTIVE_STATUSES } from '../models/Leave.js';
import LeaveType from '../models/LeaveType.js';

// Balances are calculated from the records instead of being stored, so a
// counter can never drift away from the requests behind it.
export async function getBalances(userId, year, { includeInactive = false } = {}) {
  const user = new mongoose.Types.ObjectId(userId);

  const [types, usage, adjustments, imported] = await Promise.all([
    LeaveType.find(includeInactive ? {} : { isActive: true }).sort({ order: 1, name: 1 }),
    Leave.aggregate([
      { $match: { user, year, status: { $in: ACTIVE_STATUSES } } },
      { $group: { _id: { type: '$leaveType', status: '$status' }, days: { $sum: '$days' } } },
    ]),
    BalanceAdjustment.aggregate([
      { $match: { user, year } },
      { $group: { _id: '$leaveType', days: { $sum: '$days' } } },
    ]),
    ImportedUsage.aggregate([
      { $match: { user, year } },
      { $group: { _id: '$leaveType', days: { $sum: '$days' } } },
    ]),
  ]);

  const usedDays = (typeId, status) =>
    usage.find((row) => row._id.type.equals(typeId) && row._id.status === status)?.days ?? 0;

  return types.map((type) => {
    const adjusted = adjustments.find((row) => row._id.equals(type._id))?.days ?? 0;
    const earlier = imported.find((row) => row._id.equals(type._id))?.days ?? 0;
    const approved = usedDays(type._id, 'approved');
    const pending = usedDays(type._id, 'pending');
    // Total is the yearly quota alone. An admin's adjustment adds to or takes
    // from what is available, not from the total.
    const total = type.annualQuota;
    const entitled = total + adjusted;
    const booked = earlier + approved + pending;

    return {
      leaveType: type.toJSON(),
      total: type.tracksBalance ? total : null,
      entitled: type.tracksBalance ? entitled : null,
      adjusted,
      earlier,
      approved,
      pending,
      booked,
      available: type.tracksBalance ? entitled - booked : null,
    };
  });
}

export async function getBalance(userId, leaveTypeId, year) {
  const balances = await getBalances(userId, year, { includeInactive: true });
  return balances.find((balance) => balance.leaveType.id === String(leaveTypeId));
}

// Days used per month, January first. A leave counts in the month it starts.
export async function getMonthlyUsage(userId, year) {
  const user = new mongoose.Types.ObjectId(userId);
  const months = Array(12).fill(0);

  const [imported, leaves] = await Promise.all([
    ImportedUsage.find({ user, year }).select('month days'),
    Leave.aggregate([
      { $match: { user, year, status: 'approved' } },
      { $group: { _id: { $month: '$from' }, days: { $sum: '$days' } } },
    ]),
  ]);

  for (const row of imported) months[row.month - 1] += row.days;
  for (const row of leaves) months[row._id - 1] += row.days;
  return months;
}
