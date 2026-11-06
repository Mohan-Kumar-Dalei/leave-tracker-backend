import Holiday from '../models/Holiday.js';
import Leave, { ACTIVE_STATUSES } from '../models/Leave.js';
import LeaveType from '../models/LeaveType.js';
import { parseDay, toDayString } from '../utils/dates.js';
import { badRequest, conflict, notFound } from '../utils/http.js';
import { getBalance } from './balances.js';
import { countLeaveDays } from './leaveDays.js';

// Shared by the live preview in the apply form and by the real submission, so
// what the employee sees is exactly what the server enforces.
export async function assessLeave(user, input) {
  const { leaveTypeId, session = 'full' } = input;
  const from = parseDay(input.from);
  const to = parseDay(input.to);

  if (to < from) throw badRequest('The end date cannot be before the start date.');
  if (from.getUTCFullYear() !== to.getUTCFullYear()) {
    throw badRequest('A leave cannot cross into the next year. Please send two requests.');
  }
  if (session !== 'full' && input.from !== input.to) {
    throw badRequest('Half day leave is for a single date.');
  }

  const leaveType = await LeaveType.findOne({ _id: leaveTypeId, isActive: true });
  if (!leaveType) throw notFound('That leave type is not available.');

  const year = from.getUTCFullYear();
  let holiday = null;

  if (leaveType.restrictedHolidayOnly) {
    if (input.from !== input.to || session !== 'full') {
      throw badRequest('A restricted holiday is taken as one full day.');
    }
    holiday = await Holiday.findOne({ date: from, restricted: true });
    if (!holiday) throw badRequest('Pick a date that is on the restricted holiday list.');
  }

  const days = await countLeaveDays({ from, to, session });
  if (days === 0) {
    throw badRequest('Those dates are weekends or holidays, so no leave is needed.');
  }

  const overlap = await Leave.findOne({
    user: user.id,
    status: { $in: ACTIVE_STATUSES },
    from: { $lte: to },
    to: { $gte: from },
  }).select('from to');

  if (overlap) {
    throw conflict(
      `You already have leave from ${toDayString(overlap.from)} to ${toDayString(overlap.to)} in this range.`,
    );
  }

  const balance = await getBalance(user.id, leaveType.id, year);
  if (leaveType.tracksBalance && days > balance.available) {
    throw conflict(`You have ${balance.available} ${leaveType.name} left for ${year}, and this needs ${days}.`);
  }

  return { leaveType, holiday, from, to, days, year, session, balance };
}
