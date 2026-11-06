import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_DB_NAME = 'leave_tracker_test';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-1234';
process.env.MONGO_URI ??= 'mongodb://localhost:27017/';
process.env.CLIENT_ORIGINS = 'http://localhost:5173';

const { default: bcrypt } = await import('bcryptjs');
const { default: mongoose } = await import('mongoose');
const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { connectDb } = await import('../src/config/db.js');
const { default: Holiday } = await import('../src/models/Holiday.js');
const { default: ImportedUsage } = await import('../src/models/ImportedUsage.js');
const { default: Leave } = await import('../src/models/Leave.js');
const { default: LeaveType } = await import('../src/models/LeaveType.js');
const { default: User } = await import('../src/models/User.js');
const { parseDay } = await import('../src/utils/dates.js');
const { countLeaveDays } = await import('../src/services/leaveDays.js');
const { toCsv } = await import('../src/utils/http.js');

const PASSWORD = 'correct-horse-42';
const YEAR = 2031; // Far from today so nothing depends on the real calendar.
let passwordHash;
let app;
let casual;
let rh;
let lwp;

async function makeUser(overrides = {}) {
  const suffix = new mongoose.Types.ObjectId().toString().slice(-8);
  return User.create({
    name: 'Test Person',
    email: `person-${suffix}@example.com`,
    employeeId: `T-${suffix}`,
    passwordHash,
    ...overrides,
  });
}

async function signIn(user) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
  return agent;
}

const apply = (agent, body) =>
  agent.post('/api/leaves').send({
    leaveTypeId: casual.id,
    reason: 'Family function',
    ...body,
  });

before(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  await connectDb();
  await mongoose.connection.dropDatabase();
  await User.init();
  await Leave.init();
  await Holiday.init();
  await LeaveType.init();
  app = createApp();
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Leave.deleteMany({}),
    Holiday.deleteMany({}),
    LeaveType.deleteMany({}),
  ]);
  [casual, rh, lwp] = await LeaveType.create([
    { name: 'Casual', code: 'CL', annualQuota: 3 },
    { name: 'Restricted', code: 'RH', annualQuota: 1, restrictedHolidayOnly: true },
    { name: 'Unpaid', code: 'LWP', tracksBalance: false },
  ]);
});

describe('day counting', () => {
  it('skips weekends and public holidays but not restricted holidays', async () => {
    await Holiday.create([
      { name: 'Public', date: parseDay('2031-03-05') },
      { name: 'Optional', date: parseDay('2031-03-06'), restricted: true },
    ]);
    // Mon 3 Mar to Sun 9 Mar 2031: 5 weekdays, minus 1 public holiday.
    const days = await countLeaveDays({ from: parseDay('2031-03-03'), to: parseDay('2031-03-09') });
    assert.equal(days, 4);
  });

  it('counts half a day for a half day session', async () => {
    const day = parseDay('2031-03-03');
    assert.equal(await countLeaveDays({ from: day, to: day, session: 'first' }), 0.5);
  });
});

describe('auth', () => {
  it('sets httpOnly strict cookies and never returns the password hash', async () => {
    const user = await makeUser();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: PASSWORD })
      .expect(200);

    const cookies = res.headers['set-cookie'].join(';');
    assert.match(cookies, /HttpOnly/);
    assert.match(cookies, /SameSite=Strict/);
    assert.equal(res.body.user.passwordHash, undefined);
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const user = await makeUser();
    const wrong = await request(app).post('/api/auth/login').send({ email: user.email, password: 'nope' });
    const missing = await request(app).post('/api/auth/login').send({ email: 'x@example.com', password: 'nope' });
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.equal(wrong.body.message, missing.body.message);
  });

  it('locks the account after five failed attempts', async () => {
    const user = await makeUser();
    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/api/auth/login').send({ email: user.email, password: 'nope' }).expect(401);
    }
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    assert.equal(res.status, 401);
    assert.match(res.body.message, /Too many attempts/);
  });

  it('rejects NoSQL operators in the login body', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: { $gt: '' }, password: { $gt: '' } });
    assert.equal(res.status, 400);
  });

  it('rotates refresh tokens and kills the login when an old one comes back later', async () => {
    const user = await makeUser();
    const login = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    const oldCookie = login.headers['set-cookie'].find((cookie) => cookie.startsWith('lt_refresh'));

    await request(app).post('/api/auth/refresh').set('Cookie', oldCookie).expect(200);

    const { default: RefreshToken } = await import('../src/models/RefreshToken.js');
    await RefreshToken.updateMany({}, { $set: { revokedAt: new Date(Date.now() - 60000) } });

    await request(app).post('/api/auth/refresh').set('Cookie', oldCookie).expect(401);
  });

  it('ends access at once when a user is deactivated', async () => {
    const user = await makeUser();
    const agent = await signIn(user);
    await agent.get('/api/auth/me').expect(200);
    await User.updateOne({ _id: user._id }, { isActive: false });
    await agent.get('/api/auth/me').expect(401);
  });
});

describe('access control', () => {
  it('blocks anonymous and employee access to admin routes', async () => {
    await request(app).get('/api/admin/overview').expect(401);
    const agent = await signIn(await makeUser());
    await agent.get('/api/admin/overview').expect(403);
    await agent.get('/api/admin/employees').expect(403);
  });

  it('does not let an employee cancel someone else\'s leave', async () => {
    const owner = await signIn(await makeUser());
    const other = await signIn(await makeUser());
    const { body } = await apply(owner, { from: '2031-03-03', to: '2031-03-03' }).expect(201);
    await other.patch(`/api/leaves/${body.leave.id}/cancel`).expect(403);
  });

  it('rejects writes from an origin that is not allowed', async () => {
    const user = await makeUser();
    await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: user.email, password: PASSWORD })
      .expect(403);
  });

  it('sends security headers', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-powered-by'], undefined);
    assert.ok(res.headers['content-security-policy']);
  });
});

describe('applying for leave', () => {
  it('books days against the balance and rejects more than is available', async () => {
    const agent = await signIn(await makeUser());
    await apply(agent, { from: '2031-03-03', to: '2031-03-04' }).expect(201);

    const res = await apply(agent, { from: '2031-03-10', to: '2031-03-11' });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /You have 1 Casual left/);
  });

  it('rejects overlapping leave', async () => {
    const agent = await signIn(await makeUser());
    await apply(agent, { from: '2031-03-03', to: '2031-03-04' }).expect(201);
    await apply(agent, { from: '2031-03-04', to: '2031-03-04' }).expect(409);
  });

  it('rejects leave on a weekend only', async () => {
    const agent = await signIn(await makeUser());
    await apply(agent, { from: '2031-03-08', to: '2031-03-09' }).expect(400);
  });

  it('rejects reversed dates, fake dates and year crossing', async () => {
    const agent = await signIn(await makeUser());
    await apply(agent, { from: '2031-03-04', to: '2031-03-03' }).expect(400);
    await apply(agent, { from: '2031-02-30', to: '2031-03-03' }).expect(400);
    await apply(agent, { from: '2031-12-31', to: '2032-01-02' }).expect(400);
  });

  it('rejects extra fields such as a self approved status', async () => {
    const agent = await signIn(await makeUser());
    await apply(agent, { from: '2031-03-03', to: '2031-03-03', status: 'approved' }).expect(400);
  });

  it('lets unpaid leave go beyond any balance', async () => {
    const agent = await signIn(await makeUser());
    await apply(agent, { leaveTypeId: lwp.id, from: '2031-03-03', to: '2031-03-14' }).expect(201);
  });

  it('only allows restricted leave on a restricted holiday, once', async () => {
    await Holiday.create({ name: 'Optional', date: parseDay('2031-03-06'), restricted: true });
    const agent = await signIn(await makeUser());
    await apply(agent, { leaveTypeId: rh.id, from: '2031-03-05', to: '2031-03-05' }).expect(400);
    await apply(agent, { leaveTypeId: rh.id, from: '2031-03-06', to: '2031-03-06' }).expect(201);
    await apply(agent, { leaveTypeId: rh.id, from: '2031-03-06', to: '2031-03-06' }).expect(409);
  });
});

describe('leave from the old sheet', () => {
  it('counts against the balance and shows by month', async () => {
    const user = await makeUser();
    await ImportedUsage.deleteMany({});
    await ImportedUsage.create({ user: user._id, leaveType: casual._id, year: YEAR, month: 2, days: 2.5 });
    const agent = await signIn(user);

    const { body } = await agent.get(`/api/me/summary?year=${YEAR}`).expect(200);
    const row = body.balances.find((balance) => balance.leaveType.code === 'CL');
    assert.equal(row.booked, 2.5);
    assert.equal(row.available, 0.5);
    assert.equal(body.bookedThisYear, 2.5);
    assert.equal(body.monthly[1], 2.5);

    await apply(agent, { from: '2031-03-03', to: '2031-03-03' }).expect(409);
    await apply(agent, { from: '2031-03-03', to: '2031-03-03', session: 'first' }).expect(201);
  });
});

describe('review flow', () => {
  it('moves a request through approval and updates the summary', async () => {
    const employee = await signIn(await makeUser());
    const admin = await signIn(await makeUser({ role: 'admin' }));

    const { body } = await apply(employee, { from: '2031-03-03', to: '2031-03-04' }).expect(201);
    assert.equal(body.leave.status, 'pending');

    const reviewed = await admin
      .patch(`/api/admin/leaves/${body.leave.id}/review`)
      .send({ decision: 'approved' })
      .expect(200);
    assert.equal(reviewed.body.leave.status, 'approved');

    const summary = await employee.get(`/api/me/summary?year=${YEAR}`).expect(200);
    const row = summary.body.balances.find((balance) => balance.leaveType.code === 'CL');
    assert.equal(row.approved, 2);
    assert.equal(row.available, 1);
  });

  it('stops the same request being decided twice', async () => {
    const employee = await signIn(await makeUser());
    const admin = await signIn(await makeUser({ role: 'admin' }));
    const { body } = await apply(employee, { from: '2031-03-03', to: '2031-03-03' }).expect(201);
    const url = `/api/admin/leaves/${body.leave.id}/review`;
    await admin.patch(url).send({ decision: 'approved' }).expect(200);
    await admin.patch(url).send({ decision: 'rejected', note: 'Changed my mind' }).expect(409);
  });

  it('needs a note to reject, and rejected days return to the balance', async () => {
    const employee = await signIn(await makeUser());
    const admin = await signIn(await makeUser({ role: 'admin' }));
    const { body } = await apply(employee, { from: '2031-03-03', to: '2031-03-05' }).expect(201);
    const url = `/api/admin/leaves/${body.leave.id}/review`;

    await admin.patch(url).send({ decision: 'rejected' }).expect(400);
    await admin.patch(url).send({ decision: 'rejected', note: 'Release week' }).expect(200);

    const summary = await employee.get(`/api/me/summary?year=${YEAR}`);
    const row = summary.body.balances.find((balance) => balance.leaveType.code === 'CL');
    assert.equal(row.available, 3);
  });

  it('blocks reviewing your own request when another admin exists', async () => {
    const first = await makeUser({ role: 'admin' });
    await makeUser({ role: 'admin' });
    const agent = await signIn(first);
    const { body } = await apply(agent, { from: '2031-03-03', to: '2031-03-03' }).expect(201);
    await agent.patch(`/api/admin/leaves/${body.leave.id}/review`).send({ decision: 'approved' }).expect(403);
  });

  it('creates a bell notification for the admin and the employee', async () => {
    const employee = await signIn(await makeUser());
    const admin = await signIn(await makeUser({ role: 'admin' }));
    const { body } = await apply(employee, { from: '2031-03-03', to: '2031-03-03' }).expect(201);

    const waitForUnread = async (agent) => {
      for (let i = 0; i < 20; i += 1) {
        const res = await agent.get('/api/notifications');
        if (res.body.unread > 0) return res.body;
        await new Promise((resolve) => { setTimeout(resolve, 25); });
      }
      return { unread: 0 };
    };

    assert.equal((await waitForUnread(admin)).unread, 1);
    await admin.patch(`/api/admin/leaves/${body.leave.id}/review`).send({ decision: 'approved' }).expect(200);
    assert.equal((await waitForUnread(employee)).unread, 1);
  });

  it('keeps one active admin', async () => {
    const onlyAdmin = await makeUser({ role: 'admin' });
    const agent = await signIn(onlyAdmin);
    await agent.patch(`/api/admin/employees/${onlyAdmin.id}`).send({ isActive: false }).expect(409);
  });
});

describe('team calendar', () => {
  const month = '2031-03';

  it('shows colleagues leave to employees without private details', async () => {
    const owner = await signIn(await makeUser({ name: 'Asha Rao' }));
    const colleague = await signIn(await makeUser());
    await apply(owner, { from: '2031-03-03', to: '2031-03-04', reason: 'Private family matter' }).expect(201);

    const { body } = await colleague.get(`/api/team-calendar?month=${month}`).expect(200);
    assert.equal(body.leaves.length, 1);
    assert.equal(body.leaves[0].name, 'Asha Rao');
    assert.equal(body.leaves[0].from, '2031-03-03');
    assert.equal(body.leaves[0].status, 'pending');
    assert.equal(body.leaves[0].reason, undefined);
    assert.equal(body.leaves[0].leaveType, undefined);
    assert.equal(JSON.stringify(body).includes('Private family matter'), false);
    assert.equal(JSON.stringify(body).includes('@example.com'), false);
  });

  it('adds the leave type for an admin', async () => {
    const owner = await signIn(await makeUser());
    const admin = await signIn(await makeUser({ role: 'admin' }));
    await apply(owner, { from: '2031-03-03', to: '2031-03-03' }).expect(201);

    const { body } = await admin.get(`/api/team-calendar?month=${month}`).expect(200);
    assert.equal(body.leaves[0].leaveType, 'Casual');
  });

  it('leaves out rejected and cancelled requests', async () => {
    const owner = await signIn(await makeUser());
    const admin = await signIn(await makeUser({ role: 'admin' }));
    const rejected = await apply(owner, { from: '2031-03-03', to: '2031-03-03' }).expect(201);
    const cancelled = await apply(owner, { from: '2031-03-05', to: '2031-03-05' }).expect(201);

    await admin.patch(`/api/admin/leaves/${rejected.body.leave.id}/review`).send({ decision: 'rejected', note: 'Busy week' }).expect(200);
    await owner.patch(`/api/leaves/${cancelled.body.leave.id}/cancel`).expect(200);

    const { body } = await owner.get(`/api/team-calendar?month=${month}`).expect(200);
    assert.equal(body.leaves.length, 0);
  });

  it('needs a session and a valid month', async () => {
    await request(app).get(`/api/team-calendar?month=${month}`).expect(401);
    const agent = await signIn(await makeUser());
    await agent.get('/api/team-calendar?month=2031-13').expect(400);
  });
});

describe('csv export', () => {
  it('neutralises spreadsheet formulas in typed text', () => {
    const csv = toCsv(['Reason'], [['=HYPERLINK("http://evil")']]);
    assert.match(csv, /"'=HYPERLINK/);
  });
});
