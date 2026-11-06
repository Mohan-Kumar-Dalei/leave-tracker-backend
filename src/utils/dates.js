// Leave dates are calendar days, not moments in time. They travel through the
// API as YYYY-MM-DD strings and are stored as midnight UTC so a timezone can
// never move a leave onto a different day.

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseDay(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

export function toDayString(date) {
  if (!date) return date;
  return new Date(date).toISOString().slice(0, 10);
}

export function todayString(timeZone, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function addDays(date, amount) {
  return new Date(date.getTime() + amount * DAY_MS);
}

export function yearRange(year) {
  return {
    start: new Date(Date.UTC(year, 0, 1)),
    end: new Date(Date.UTC(year, 11, 31)),
  };
}

export function monthRange(year, monthIndex) {
  return {
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex + 1, 0)),
  };
}

export function isRealDay(value) {
  const parsed = parseDay(value);
  return !Number.isNaN(parsed.getTime()) && toDayString(parsed) === value;
}
