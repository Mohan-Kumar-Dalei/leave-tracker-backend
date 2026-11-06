import bcrypt from 'bcryptjs';
import env from './config/env.js';
import { connectDb, disconnectDb } from './config/db.js';
import BalanceAdjustment from './models/BalanceAdjustment.js';
import Holiday from './models/Holiday.js';
import Leave from './models/Leave.js';
import LeaveType from './models/LeaveType.js';
import User from './models/User.js';
import { countLeaveDays } from './services/leaveDays.js';
import { parseDay, toDayString, todayString, addDays } from './utils/dates.js';

const DATE_NOTE = 'Subject to change depending on the actual holiday date (as per past experience)';

const LEAVE_TYPES = [
  { code: 'CLSL', name: 'Casual Leave/Sick Leave', annualQuota: 12, order: 1, description: 'For personal work or when you are unwell.' },
  { code: 'CO', name: 'Compensatory Off', annualQuota: 0, order: 2, description: 'Credited by an admin when you work on a holiday.' },
  { code: 'EL', name: 'Earned Leave (Manual)', annualQuota: 0, order: 3, description: 'Credited manually by an admin.' },
  { code: 'LWP', name: 'Leave Without Pay', annualQuota: 0, order: 4, tracksBalance: false, description: 'Unpaid leave when your balance is used up.' },
  { code: 'RH', name: 'Restricted Holidays', annualQuota: 2, order: 5, restrictedHolidayOnly: true, description: 'Pick from the restricted holiday list.' },
];

const HOLIDAYS_2026 = [
  ['2026-01-26', 'Republic Day'],
  ['2026-03-04', 'Holi'],
  ['2026-08-15', 'Independence Day'],
  ['2026-08-28', 'Raksha Bandhan'],
  ['2026-09-14', 'Ganesh Chaturthi', true],
  ['2026-10-02', 'Mahatma Gandhi Jayanti'],
  ['2026-10-20', 'Dusshera'],
  ['2026-11-08', 'Diwali'],
  ['2026-12-25', 'Christmas'],
];

const DEMO_EMPLOYEES = [
  { name: 'Ananya Rao', email: 'ananya.rao@leavetracker.test', employeeId: 'EMP-1001', department: 'Engineering', designation: 'Senior Developer' },
  { name: 'Rohit Mishra', email: 'rohit.mishra@leavetracker.test', employeeId: 'EMP-1002', department: 'Engineering', designation: 'Frontend Developer' },
  { name: 'Priya Nair', email: 'priya.nair@leavetracker.test', employeeId: 'EMP-1003', department: 'Design', designation: 'Product Designer' },
  { name: 'Arjun Sethi', email: 'arjun.sethi@leavetracker.test', employeeId: 'EMP-1004', department: 'Sales', designation: 'Account Manager' },
  { name: 'Meera Pillai', email: 'meera.pillai@leavetracker.test', employeeId: 'EMP-1005', department: 'Finance', designation: 'Accountant' },
  { name: 'Kabir Khanna', email: 'kabir.khanna@leavetracker.test', employeeId: 'EMP-1006', department: 'Support', designation: 'Support Lead' },
];

async function seedCatalog() {
  for (const type of LEAVE_TYPES) {
    await LeaveType.updateOne({ code: type.code }, { $setOnInsert: type }, { upsert: true });
  }
  for (const [date, name, restricted = false] of HOLIDAYS_2026) {
    await Holiday.updateOne(
      { date: parseDay(date) },
      { $setOnInsert: { name, restricted, note: DATE_NOTE } },
      { upsert: true },
    );
  }
  console.log(`Leave types: ${LEAVE_TYPES.length}, holidays: ${HOLIDAYS_2026.length}`);
}

async function seedAdmin() {
  const { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password, SEED_ADMIN_NAME: name } = env;
  if (!email || !password) {
    console.log('Skipping admin: set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env');
    return null;
  }

  const existing = await User.findOne({ email });
  if (existing) {
    console.log(`Admin already exists: ${email}`);
    return existing;
  }

  const admin = await User.create({
    name,
    email,
    employeeId: 'ADM-0001',
    role: 'admin',
    department: 'People',
    designation: 'HR Admin',
    joinedOn: parseDay('2022-04-01'),
    passwordHash: await bcrypt.hash(password, 12),
  });
  console.log(`Admin created: ${email}`);
  return admin;
}

async function seedDemo(admin) {
  if (env.isProduction) {
    console.log('Demo data is not available in production.');
    return;
  }
  if (!env.SEED_EMPLOYEE_PASSWORD) {
    console.log('Skipping demo data: set SEED_EMPLOYEE_PASSWORD in .env');
    return;
  }

  const passwordHash = await bcrypt.hash(env.SEED_EMPLOYEE_PASSWORD, 12);
  const people = [];

  for (const person of DEMO_EMPLOYEES) {
    const user = await User.findOneAndUpdate(
      { email: person.email },
      { $setOnInsert: { ...person, passwordHash, joinedOn: parseDay('2024-06-03') } },
      { upsert: true, returnDocument: 'after' },
    );
    people.push(user);
  }

  await Leave.deleteMany({ user: { $in: people.map((person) => person._id) } });
  await BalanceAdjustment.deleteMany({ user: { $in: people.map((person) => person._id) } });

  const types = Object.fromEntries((await LeaveType.find()).map((type) => [type.code, type]));
  const today = parseDay(todayString(env.TIMEZONE));
  const on = (offset) => toDayString(addDays(today, offset));

  const samples = [
    [0, 'CLSL', on(-40), on(-39), 'approved', 'Family function in Bhubaneswar'],
    [0, 'CLSL', on(-12), on(-12), 'rejected', 'Personal work at the bank', 'Release week, please pick another date'],
    [0, 'CLSL', on(19), on(21), 'pending', 'Travelling home for a cousin\'s wedding'],
    [1, 'CLSL', on(-3), on(0), 'approved', 'Fever, doctor advised rest'],
    [1, 'LWP', on(-70), on(-70), 'approved', 'Extended trip, balance not enough'],
    [2, 'CLSL', on(0), on(1), 'approved', 'Moving to a new flat'],
    [2, 'CLSL', on(4), on(5), 'pending', 'Passport appointment and paperwork'],
    [3, 'CLSL', on(10), on(12), 'pending', 'Visiting parents in Pune'],
    [4, 'CLSL', on(6), on(6), 'approved', 'School admission for my son'],
    [5, 'EL', on(13), on(14), 'pending', 'Short break after the audit'],
    [5, 'CLSL', on(-25), on(-24), 'approved', 'Dental procedure'],
  ];

  await BalanceAdjustment.create([
    { user: people[5]._id, leaveType: types.EL._id, year: 2026, days: 6, reason: 'Carried forward from 2025', createdBy: admin._id },
    { user: people[0]._id, leaveType: types.CO._id, year: 2026, days: 1, reason: 'Worked on Sunday for the October release', createdBy: admin._id },
  ]);

  for (const [index, code, from, to, status, reason, reviewNote = ''] of samples) {
    const days = await countLeaveDays({ from: parseDay(from), to: parseDay(to) });
    if (days === 0) continue;
    const decided = status !== 'pending';
    await Leave.create({
      user: people[index]._id,
      leaveType: types[code]._id,
      from: parseDay(from),
      to: parseDay(to),
      days,
      year: parseDay(from).getUTCFullYear(),
      reason,
      status,
      reviewNote,
      reviewedBy: decided ? admin._id : undefined,
      reviewedAt: decided ? new Date() : undefined,
    });
  }

  console.log(`Demo employees: ${people.length}, demo leaves: ${samples.length}`);
}

async function run() {
  await connectDb();
  await seedCatalog();
  const admin = await seedAdmin();
  if (process.argv.includes('--demo') && admin) await seedDemo(admin);
  await disconnectDb();
}

run().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
