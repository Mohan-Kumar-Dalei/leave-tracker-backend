import env from '../config/env.js';
import Holiday from '../models/Holiday.js';
import { addDays } from '../utils/dates.js';

export function isWeekend(date) {
  return env.weekendDays.includes(date.getUTCDay());
}

// Counts the working days a leave uses. Weekly offs and public holidays inside the
// range are free. Restricted holidays count, since they are normal working days
// for anyone who does not avail them.
export async function countLeaveDays({ from, to, session = 'full' }) {
  const publicHolidays = await Holiday.find({
    date: { $gte: from, $lte: to },
    restricted: false,
  }).select('date');

  const closed = new Set(publicHolidays.map((holiday) => holiday.date.getTime()));

  let days = 0;
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
    if (!isWeekend(cursor) && !closed.has(cursor.getTime())) days += 1;
  }

  if (days > 0 && session !== 'full') return 0.5;
  return days;
}
