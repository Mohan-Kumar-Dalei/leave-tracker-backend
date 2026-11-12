import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_DB_NAME = 'leave_tracker_test_gmail';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-1234';
process.env.MONGO_URI ??= 'mongodb://localhost:27017/';
process.env.CLIENT_ORIGINS = 'http://localhost:5173';
process.env.APP_URL = 'http://localhost:5173';
process.env.GMAIL_TOKEN_KEY = 'cd'.repeat(32);
process.env.SMTP_HOST = '';
process.env.LEAVE_MAIL_CC = 'HR Team <hr@example.com>';

const { default: bcrypt } = await import('bcryptjs');
const { default: mongoose } = await import('mongoose');
const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { connectDb } = await import('../src/config/db.js');
const { default: Notification } = await import('../src/models/Notification.js');
const { default: User } = await import('../src/models/User.js');
const { open } = await import('../src/services/secretBox.js');
const { deliverMail } = await import('../src/services/mail.js');
const { smtp } = await import('../src/services/appPassword.js');
const { default: AppPasswordLink } = await import('../src/models/AppPasswordLink.js');

// Gmail's SMTP, swapped per test. verify() and sendMail() follow `gmailSmtp`.
let gmailSmtp;
smtp.create = (email, password) => ({
  verify: async () => gmailSmtp.verify(email, password),
  sendMail: async (message) => gmailSmtp.send(email, password, message),
  close: () => {},
});
const authError = () => Object.assign(new Error('535 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 });

const PASSWORD = 'correct-horse-42';
let app;
let passwordHash;
async function makeUser(overrides = {}) {
  const suffix = new mongoose.Types.ObjectId().toString().slice(-8);
  return User.create({
    name: 'Gmail Person',
    email: `person-${suffix}@example.com`,
    employeeId: `G-${suffix}`,
    passwordHash,
    ...overrides,
  });
}

async function signIn(user) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
  return agent;
}

before(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  await connectDb();
  app = createApp();
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await fs.rm('.mail-outbox', { recursive: true, force: true });
});

beforeEach(async () => {
  gmailSmtp = { verify: async () => true, send: async () => ({}) };
  await Promise.all([
    User.deleteMany({}),
    AppPasswordLink.deleteMany({}),
    Notification.deleteMany({}),
  ]);
});

describe('Gmail App Password', () => {
  const mail = (sender) => ({
    to: ['boss@example.com'],
    sender,
    subject: 'Leave Application',
    html: '<p>Hi Sir</p>',
    text: 'Hi Sir',
    messageId: '<leave.9@example.com>',
  });

  it('uses the app mailbox for people without an App Password', async () => {
    const user = await makeUser();
    let used = false;
    gmailSmtp.send = async () => {
      used = true;
    };
    assert.equal(await deliverMail(mail(user)), true);
    assert.equal(used, false);
  });

  it('checks the App Password with Gmail before saving it, encrypted', async () => {
    const user = await makeUser();
    const agent = await signIn(user);

    await agent.post('/api/me/gmail/app-password').send({ appPassword: 'short' }).expect(400);

    gmailSmtp.verify = async () => {
      throw authError();
    };
    const refused = await agent.post('/api/me/gmail/app-password').send({ appPassword: 'abcd efgh ijkl mnop' }).expect(400);
    assert.match(refused.body.message, /did not accept/);
    assert.equal(await AppPasswordLink.countDocuments(), 0);

    let signedInAs;
    gmailSmtp.verify = async (email, password) => {
      signedInAs = [email, password];
    };
    const { body } = await agent.post('/api/me/gmail/app-password').send({ appPassword: 'ABCD efgh IJKL mnop' }).expect(200);
    assert.deepEqual(signedInAs, [user.email, 'abcdefghijklmnop']);
    assert.equal(JSON.stringify(body).includes('abcd'), false);

    const link = await AppPasswordLink.findOne({ user: user._id }).select('+password');
    assert.equal(link.password.includes('abcdefghijklmnop'), false);
    assert.equal(open(link.password), 'abcdefghijklmnop');

    const status = await agent.get('/api/me/gmail').expect(200);
    assert.deepEqual([status.body.connected, status.body.email], [true, user.email]);
    assert.equal(JSON.stringify(status.body).includes('abcdefghijklmnop'), false);

    await agent.delete('/api/me/gmail/app-password').expect(204);
    assert.equal(await AppPasswordLink.countDocuments(), 0);
  });

  it('sends the forgot password mail from their own Gmail to themselves', async () => {
    const { resetMail } = await import('../src/services/mailTemplates.js');
    const user = await makeUser({ name: 'Asha Rao' });
    const agent = await signIn(user);
    await agent.post('/api/me/gmail/app-password').send({ appPassword: 'abcdefghijklmnop' }).expect(200);

    let sent;
    gmailSmtp.send = async (email, password, message) => {
      sent = { email, message };
    };
    // The same options the forgot password route sends with.
    assert.equal(await deliverMail({ to: user.email, sender: user, ...resetMail({ user, token: 'tok-123' }) }), true);
    assert.equal(sent.email, user.email, 'signed in to Gmail as the person');
    assert.deepEqual(sent.message.from, { name: 'Asha Rao', address: user.email });
    assert.deepEqual(sent.message.to.map((to) => to.address ?? to), [user.email]);
    assert.match(sent.message.subject, /Reset your .* password/);
    assert.match(sent.message.html, /reset-password\?token=tok-123/);
  });

  it('sends from their own address over Gmail SMTP', async () => {
    const user = await makeUser({ name: 'Asha Rao' });
    const agent = await signIn(user);
    await agent.post('/api/me/gmail/app-password').send({ appPassword: 'abcdefghijklmnop' }).expect(200);

    let sent;
    gmailSmtp.send = async (email, password, message) => {
      sent = { email, password, message };
    };
    assert.equal(await deliverMail(mail(user)), true);
    assert.deepEqual([sent.email, sent.password], [user.email, 'abcdefghijklmnop']);
    assert.deepEqual(sent.message.from, { name: 'Asha Rao', address: user.email });
    assert.equal(sent.message.replyTo, undefined);
    assert.equal(sent.message.messageId, '<leave.9@example.com>');
  });

  it('marks it and tells the person when Google stops accepting it', async () => {
    const user = await makeUser();
    const agent = await signIn(user);
    await agent.post('/api/me/gmail/app-password').send({ appPassword: 'abcdefghijklmnop' }).expect(200);

    gmailSmtp.send = async () => {
      throw authError();
    };
    assert.equal(await deliverMail(mail(user)), true, 'the mail still goes, from the app');
    const link = await AppPasswordLink.findOne({ user: user._id });
    assert.ok(link.brokenAt);
    assert.ok(await Notification.findOne({ recipient: user._id, kind: 'gmail', title: /App Password/ }));
    const status = await agent.get('/api/me/gmail').expect(200);
    assert.deepEqual([status.body.connected, status.body.needsReconnect], [false, true]);
  });
});
