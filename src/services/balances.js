import mongoose from 'mongoose';
import BalanceAdjustment from '../models/BalanceAdjustment.js';
import Leave, { ACTIVE_STATUSES } from '../models/Leave.js';
import LeaveType from '../models/LeaveType.js';

// Balances are calculated from the leave records instead of being stored, so a
// counter can never drift away from the requests behind it.
export async function getBalances(userId, year, { includeInactive = false } = {}) {
  const user = new mongoose.Types.ObjectId(userId);

  const [types, usage, adjustments] = await Promise.all([
    LeaveType.find(includeInactive ? {} : { isActive: true }).sort({ order: 1, name: 1 }),
    Leave.aggregate([
      { $match: { user, year, status: { $in: ACTIVE_STATUSES } } },
      { $group: { _id: { type: '$leaveType', status: '$status' }, days: { $sum: '$days' } } },
    ]),
    BalanceAdjustment.aggregate([
      { $match: { user, year } },
      { $group: { _id: '$leaveType', days: { $sum: '$days' } } },
    ]),
  ]);

  const usedDays = (typeId, status) =>
    usage.find((row) => row._id.type.equals(typeId) && row._id.status === status)?.days ?? 0;

  return types.map((type) => {
    const adjusted = adjustments.find((row) => row._id.equals(type._id))?.days ?? 0;
    const approved = usedDays(type._id, 'approved');
    const pending = usedDays(type._id, 'pending');
    const entitled = type.annualQuota + adjusted;

    return {
      leaveType: type.toJSON(),
      entitled: type.tracksBalance ? entitled : null,
      adjusted,
      approved,
      pending,
      booked: approved + pending,
      available: type.tracksBalance ? entitled - approved - pending : null,
    };
  });
}

export async function getBalance(userId, leaveTypeId, year) {
  const balances = await getBalances(userId, year, { includeInactive: true });
  return balances.find((balance) => balance.leaveType.id === String(leaveTypeId));
}
