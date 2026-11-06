// Loads the real team from a private JSON file that is not kept in Git.
//
//   npm run import:roster -- data/roster.local.json
//   npm run import:roster -- data/roster.local.json --remove-demo
//
// File shape:
//   {
//     "year": 2026,
//     "leaveTypeCode": "CLSL",
//     "admin": { "name": "...", "email": "..." },
//     "employees": [{ "name": "...", "email": "...", "months": [12 numbers, Jan to Dec] }]
//   }
//
// Safe to run again: existing people keep their password, and their monthly
// usage is replaced with what the file says. No mail is sent.

import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { connectDb, disconnectDb } from './config/db.js';
import BalanceAdjustment from './models/BalanceAdjustment.js';
import ImportedUsage from './models/ImportedUsage.js';
import Leave from './models/Leave.js';
import LeaveType from './models/LeaveType.js';
import Notification from './models/Notification.js';
import RefreshToken from './models/RefreshToken.js';
import User from './models/User.js';

const DEMO_EMAIL = /@leavetracker\.test$/i;

const startingPassword = (name, year) => `${name.split(' ')[0]}@${year}`;

async function upsertPerson(person, { role, employeeId, year }) {
  const email = person.email.toLowerCase();
  const existing = await User.findOne({ email });
  if (existing) return { user: existing, created: false };

  const user = await User.create({
    name: person.name,
    email,
    employeeId,
    role,
    passwordHash: await bcrypt.hash(startingPassword(person.name, year), 12),
  });
  return { user, created: true };
}

async function removeDemoData() {
  const demoUsers = await User.find({ email: DEMO_EMAIL }).select('_id');
  const ids = demoUsers.map((user) => user._id);

  await Promise.all([
    Leave.deleteMany({ user: { $in: ids } }),
    BalanceAdjustment.deleteMany({ user: { $in: ids } }),
    Notification.deleteMany({ recipient: { $in: ids } }),
    RefreshToken.deleteMany({ user: { $in: ids } }),
    ImportedUsage.deleteMany({ user: { $in: ids } }),
  ]);
  await User.deleteMany({ _id: { $in: ids } });
  console.log(`Removed ${ids.length} demo accounts and their leaves`);
}

async function run() {
  const [file, ...flags] = process.argv.slice(2);
  if (!file) throw new Error('Pass the path of the roster JSON file.');

  const roster = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { year, leaveTypeCode, admin, employees } = roster;

  for (const person of employees) {
    if (!person.email) throw new Error(`${person.name} has no email.`);
    if (person.months.length !== 12) throw new Error(`${person.name} needs 12 monthly values.`);
  }

  await connectDb();

  const leaveType = await LeaveType.findOne({ code: leaveTypeCode });
  if (!leaveType) throw new Error(`Leave type ${leaveTypeCode} not found. Run npm run seed first.`);

  const adminResult = await upsertPerson(admin, { role: 'admin', employeeId: 'CON-001', year });
  console.log(`Admin ${adminResult.created ? 'created' : 'already exists'}`);

  let created = 0;
  for (const [index, person] of employees.entries()) {
    const employeeId = `CON-${String(index + 2).padStart(3, '0')}`;
    const result = await upsertPerson(person, { role: 'employee', employeeId, year });
    if (result.created) created += 1;

    await ImportedUsage.deleteMany({ user: result.user._id, leaveType: leaveType._id, year });
    const rows = person.months
      .map((days, month) => ({ user: result.user._id, leaveType: leaveType._id, year, month: month + 1, days }))
      .filter((row) => row.days > 0);
    if (rows.length) await ImportedUsage.insertMany(rows);
  }
  console.log(`Employees: ${created} created, ${employees.length - created} already existed`);

  if (flags.includes('--remove-demo')) await removeDemoData();

  await disconnectDb();
}

run().catch((error) => {
  console.error('Import failed:', error.message);
  process.exit(1);
});
