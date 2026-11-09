// Sends a sample leave application and the admin's approval reply to one
// address only, so the look can be checked without mailing the team.
//
//   npm run mail:test -- you@example.com [employee@email]
//
// Uses a real admin and employee for the names and signatures. Nothing is saved.
import mongoose from 'mongoose';
import env from './config/env.js';
import User from './models/User.js';
import { applicationMail, decisionMail } from './services/leaveMail.js';
import { newMessageId, sendMail } from './services/mail.js';
import { todayString } from './utils/dates.js';

const [to, employeeEmail] = process.argv.slice(2);
if (!to || !to.includes('@')) {
  console.error('Usage: npm run mail:test -- you@example.com [employee@email]');
  process.exit(1);
}

const addDays = (day, count) => {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};

await mongoose.connect(env.MONGO_URI, { dbName: env.MONGO_DB_NAME });

const admin = await User.findOne({ role: 'admin', isActive: true }).sort({ createdAt: 1 });
const employee = await User.findOne(
  employeeEmail ? { email: employeeEmail.toLowerCase() } : { role: 'employee', isActive: true },
).sort({ name: 1 });

if (!admin || !employee) {
  console.error('Need one active admin and one employee in the database.');
  await mongoose.disconnect();
  process.exit(1);
}

const from = addDays(todayString(env.TIMEZONE), 1);
const leave = {
  from,
  to: addDays(from, 1),
  session: 'full',
  days: 2,
  reason: 'Personal work',
  mailMessageId: newMessageId(),
};

// Only the test address receives these, never the CC list.
const onlyTo = (mail) => ({ ...mail, to: [to], cc: [], subject: `[Test] ${mail.subject}` });

const sentApplication = await sendMail({
  ...onlyTo(applicationMail({ employee, admins: [admin], leave, typeName: 'Casual/Sick' })),
  messageId: leave.mailMessageId,
});
const sentReply = await sendMail(onlyTo(decisionMail({ employee, reviewer: admin, leave, decision: 'approved', note: '' })));

await mongoose.disconnect();

if (!sentApplication || !sentReply) {
  console.error('Sending failed, see the error above.');
  process.exit(1);
}
console.log(`Application from ${employee.name} and reply from ${admin.name} went to ${to}.`);
console.log(env.mailEnabled ? 'Check the inbox and the spam folder.' : 'SMTP is not set, so both were saved to .mail-outbox/.');
process.exit(0);
