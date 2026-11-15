import User from '../models/User.js';

// Employee IDs follow the company's series: CON-001 (Mrutyunjaya Sahu),
// CON-002 and so on. Someone new gets the next number after the highest one
// in use, given when their account is made, so the series has no gaps from
// requests that were turned down.

const PREFIX = 'CON';
const SERIES = new RegExp(`^${PREFIX}-(\\d+)$`);

export async function nextEmployeeId() {
  const ids = await User.find({ employeeId: { $regex: `^${PREFIX}-\\d+$` } }).select('employeeId').lean();
  const highest = ids.reduce((max, { employeeId }) => Math.max(max, Number(SERIES.exec(employeeId)?.[1] ?? 0)), 0);
  return `${PREFIX}-${String(highest + 1).padStart(3, '0')}`;
}

// Creates a user with the next employee ID. Two accounts made at the same
// moment could pick the same number; the unique index turns one away, and it
// simply takes the next one.
export async function createWithNextId(fields) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await User.create({ ...fields, employeeId: await nextEmployeeId() });
    } catch (error) {
      const clash = error?.code === 11000 && Object.keys(error.keyPattern ?? {}).includes('employeeId');
      if (!clash || attempt === 4) throw error;
    }
  }
  throw new Error('Could not give an employee ID.');
}
