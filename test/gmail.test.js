import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_DB_NAME = 'leave_tracker_test_gmail';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-1234';
process.env.MONGO_URI ??= 'mongodb://localhost:27017/';
process.env.CLIENT_ORIGINS = 'http://localhost:5173';
process.env.APP_URL = 'http://localhost:5173';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GMAIL_TOKEN_KEY = 'cd'.repeat(32);
process.env.SMTP_HOST = '';
process.env.LEAVE_MAIL_CC = 'HR Team <hr@example.com>';

const { default: bcrypt } = await import('bcryptjs');
const { default: mongoose } = await import('mongoose');
const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { connectDb } = await import('../src/config/db.js');
const { default: GmailLink } = await import('../src/models/GmailLink.js');
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
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

let app;
let passwordHash;
const realFetch = globalThis.fetch;

// Google's answers, swapped in per test. Every call is recorded.
let google;
let calls;
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  const answer = google(String(url), init);
  return new Response(JSON.stringify(answer.body), {
    status: answer.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const idToken = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

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

// Runs the whole connect flow for a user, with Google answering for `email`.
async function connect(user, { email = user.email, scope = `openid email ${SEND_SCOPE}`, refresh = 'refresh-1' } = {}) {
  const agent = await signIn(user);
  const { body, headers } = await agent.post('/api/me/gmail/connect').expect(200);
  const url = new URL(body.url);
  const state = url.searchParams.get('state');
  google = (target) =>
    target === TOKEN_URL
      ? {
          body: {
            access_token: 'access-1',
            expires_in: 3600,
            scope,
            refresh_token: refresh,
            id_token: idToken({ email, email_verified: true }),
          },
        }
      : { status: 404, body: {} };
  const res = await agent.get(`/api/auth/google/callback?code=abc&state=${state}`).expect(303);
  return { agent, res, url, state, setCookie: headers['set-cookie'] };
}

before(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  await connectDb();
  app = createApp();
});

after(async () => {
  globalThis.fetch = realFetch;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await fs.rm('.mail-outbox', { recursive: true, force: true });
});

beforeEach(async () => {
  calls = [];
  google = () => ({ status: 500, body: {} });
  gmailSmtp = { verify: async () => true, send: async () => ({}) };
  await Promise.all([
    User.deleteMany({}),
    GmailLink.deleteMany({}),
    AppPasswordLink.deleteMany({}),
    Notification.deleteMany({}),
  ]);
});

describe('connect Gmail', () => {
  it('sends the person to Google with only the send permission', async () => {
    const user = await makeUser();
    const { url, setCookie, res } = await connect(user);
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('scope'), `openid email ${SEND_SCOPE}`);
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:5173/api/auth/google/callback');
    assert.equal(url.searchParams.get('login_hint'), user.email);
    assert.match(setCookie.join(';'), /lt_gstate=.+Path=\/api\/auth\/google.+HttpOnly.+SameSite=Lax/);
    assert.equal(res.headers.location, 'http://localhost:5173/profile?gmail=connected');
  });

  it('keeps the token encrypted and reports the connection', async () => {
    const user = await makeUser();
    const { agent } = await connect(user, { refresh: 'refresh-secret' });
    const link = await GmailLink.findOne({ user: user._id }).select('+refreshToken');
    assert.equal(link.refreshToken.includes('refresh-secret'), false);
    assert.equal(open(link.refreshToken), 'refresh-secret');

    const { body } = await agent.get('/api/me/gmail').expect(200);
    assert.deepEqual([body.available, body.connected, body.email], [true, true, user.email]);
    assert.equal(JSON.stringify(body).includes('refresh'), false);
  });

  it('refuses a different Google account, a missing permission and a reused state', async () => {
    const user = await makeUser();
    const wrong = await connect(user, { email: 'someone.else@gmail.com' });
    assert.equal(wrong.res.headers.location, 'http://localhost:5173/profile?gmail=wrong-account');

    const noSend = await connect(user, { scope: 'openid email' });
    assert.equal(noSend.res.headers.location, 'http://localhost:5173/profile?gmail=no-permission');
    assert.equal(await GmailLink.countDocuments(), 0);

    const ok = await connect(user);
    const replay = await ok.agent.get(`/api/auth/google/callback?code=abc&state=${ok.state}`).expect(303);
    assert.equal(replay.headers.location, 'http://localhost:5173/profile?gmail=expired');
  });

  it('needs the state cookie from the same browser', async () => {
    const user = await makeUser();
    const agent = await signIn(user);
    const { body } = await agent.post('/api/me/gmail/connect').expect(200);
    const state = new URL(body.url).searchParams.get('state');
    const res = await request(app).get(`/api/auth/google/callback?code=abc&state=${state}`).expect(303);
    assert.equal(res.headers.location, 'http://localhost:5173/profile?gmail=expired');
  });

  it('disconnects and asks Google to drop the token', async () => {
    const user = await makeUser();
    const { agent } = await connect(user);
    google = () => ({ body: {} });
    await agent.delete('/api/me/gmail').expect(204);
    assert.equal(await GmailLink.countDocuments(), 0);
    assert.ok(calls.some((call) => call.url === 'https://oauth2.googleapis.com/revoke'));
  });
});

describe("sending from the person's own Gmail", () => {
  const mail = (sender) => ({
    to: ['boss@example.com'],
    cc: ['hr@example.com', 'typed@example.org'],
    sender,
    subject: 'Leave Application',
    html: '<p>Hi Sir</p>',
    text: 'Hi Sir',
    messageId: '<leave.1@example.com>',
    inReplyTo: '<leave.0@example.com>',
  });

  it('sends through the Gmail API from their own address', async () => {
    const user = await makeUser({ name: 'Asha Rao' });
    await makeUser({ name: 'Boss Person', email: 'boss@example.com' });
    await connect(user);
    let sent;
    google = (url, init) => {
      if (url === TOKEN_URL) return { body: { access_token: 'access-2', expires_in: 3600 } };
      if (url === SEND_URL) {
        sent = {
          auth: init.headers.Authorization,
          raw: Buffer.from(JSON.parse(init.body).raw, 'base64url').toString(),
        };
        return { body: { id: 'm1', threadId: 't1' } };
      }
      return { status: 404, body: {} };
    };

    assert.equal(await deliverMail(mail(user)), true);
    assert.match(sent.auth, /^Bearer access-/);
    assert.match(sent.raw, new RegExp(`From: Asha Rao <${user.email}>`));
    // Names from people's accounts and from the usual CC list; unknown addresses stay bare.
    assert.match(sent.raw, /To: Boss Person <boss@example.com>/);
    assert.match(sent.raw, /Cc: HR Team <hr@example.com>, typed@example.org/);
    assert.match(sent.raw, /Message-ID: <leave.1@example.com>/);
    assert.match(sent.raw, /In-Reply-To: <leave.0@example.com>/);
    assert.doesNotMatch(sent.raw, /^Reply-To:/m);
  });

  it('falls back, marks the link and tells the person when Google stops accepting it', async () => {
    const user = await makeUser();
    await connect(user);
    google = (url) => (url === TOKEN_URL ? { status: 400, body: { error: 'invalid_grant' } } : { status: 404, body: {} });

    assert.equal(await deliverMail(mail(user)), true, 'the mail still goes, from the app');
    const link = await GmailLink.findOne({ user: user._id });
    assert.ok(link.brokenAt);
    assert.ok(await Notification.findOne({ recipient: user._id, kind: 'gmail' }));
  });

  it('uses the app mailbox for people who did not connect', async () => {
    const user = await makeUser();
    assert.equal(await deliverMail(mail(user)), true);
    assert.equal(calls.length, 0);
  });
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
    assert.deepEqual([status.body.appPassword.connected, status.body.appPassword.email], [true, user.email]);
    assert.equal(JSON.stringify(status.body).includes('abcdefghijklmnop'), false);

    await agent.delete('/api/me/gmail/app-password').expect(204);
    assert.equal(await AppPasswordLink.countDocuments(), 0);
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
    assert.deepEqual([status.body.appPassword.connected, status.body.appPassword.needsReconnect], [false, true]);
  });
});
