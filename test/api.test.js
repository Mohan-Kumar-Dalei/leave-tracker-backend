import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

process.env.NODE_ENV = 'test';
process.env.MONGO_DB_NAME = 'leave_tracker_test';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-1234';
process.env.MONGO_URI ??= 'mongodb://localhost:27017/';
process.env.CLIENT_ORIGINS = 'http://localhost:5173';
process.env.WEEKEND_DAYS = '0';

const { default: bcrypt } = await import('bcryptjs');
const { default: mongoose } = await import('mongoose');
const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { connectDb } = await import('../src/config/db.js');
const { default: BalanceAdjustment } = await import('../src/models/BalanceAdjustment.js');
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
  it('skips Sundays and public holidays but not restricted holidays', async () => {
    await Holiday.create([
      { name: 'Public', date: parseDay('2031-03-05') },
      { name: 'Optional', date: parseDay('2031-03-06'), restricted: true },
    ]);
    // Mon 3 Mar to Sun 9 Mar 2031: 6 working days, minus 1 public holiday.
    const days = await countLeaveDays({ from: parseDay('2031-03-03'), to: parseDay('2031-03-09') });
    assert.equal(days, 5);
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

  it('lets an employee change their own password', async () => {
    const user = await makeUser();
    const agent = await signIn(user);
    const other = await signIn(user);
    const url = '/api/auth/change-password';

    await agent.post(url).send({ currentPassword: 'wrong-one-123', newPassword: 'brand-new-pass-1' }).expect(400);
    await agent.post(url).send({ currentPassword: PASSWORD, newPassword: 'short1' }).expect(400);
    await agent.post(url).send({ currentPassword: PASSWORD, newPassword: 'brand-new-pass-1' }).expect(200);

    await agent.get('/api/auth/me').expect(200);
    await other.get('/api/auth/me').expect(401);
    await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }).expect(401);
    await request(app).post('/api/auth/login').send({ email: user.email, password: 'brand-new-pass-1' }).expect(200);
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

  it('never serves env or source files', async () => {
    const paths = ['/.env', '/.env.passwords', '/api/.env', '/api/env', '/package.json', '/src/config/env.js', '/data/roster.local.json'];
    const agent = await signIn(await makeUser());

    for (const path of paths) {
      assert.ok([401, 404].includes((await request(app).get(path)).status), path);
      const signedIn = await agent.get(path);
      assert.equal(signedIn.status, 404, path);
      assert.equal(signedIn.text.includes(process.env.JWT_ACCESS_SECRET), false, path);
    }

    const health = await request(app).get('/api/health');
    assert.equal(JSON.stringify(health.body).includes(process.env.JWT_ACCESS_SECRET), false);
    assert.deepEqual(Object.keys(health.body).sort(), ['database', 'status']);
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

  it('rejects leave on a Sunday or a public holiday only', async () => {
    await Holiday.create({ name: 'Public', date: parseDay('2031-03-05') });
    const agent = await signIn(await makeUser());

    const sunday = await apply(agent, { from: '2031-03-09', to: '2031-03-09' });
    assert.equal(sunday.status, 400);
    assert.match(sunday.body.message, /Sunday or a holiday/);

    await apply(agent, { from: '2031-03-05', to: '2031-03-05' }).expect(400);
    const preview = await agent
      .post('/api/leaves/preview')
      .send({ leaveTypeId: casual.id, from: '2031-03-09', to: '2031-03-09' });
    assert.equal(preview.status, 400);
  });

  it('counts Saturday as a working day', async () => {
    const agent = await signIn(await makeUser());
    const saturday = await apply(agent, { from: '2031-03-08', to: '2031-03-08' }).expect(201);
    assert.equal(saturday.body.leave.days, 1);

    const preview = await agent
      .post('/api/leaves/preview')
      .send({ leaveTypeId: lwp.id, from: '2031-03-14', to: '2031-03-17' })
      .expect(200);
    assert.equal(preview.body.days, 3);
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

  it('lets an admin set the password of a new employee', async () => {
    const agent = await signIn(await makeUser({ role: 'admin' }));
    const person = { name: 'New Joiner', email: 'new.joiner@example.com', employeeId: 'NEW-1' };

    await agent.post('/api/admin/employees').send({ ...person, password: 'short1' }).expect(400);

    const { body } = await agent
      .post('/api/admin/employees')
      .send({ ...person, password: 'Joiner@2026' })
      .expect(201);
    assert.equal(body.user.passwordHash, undefined);
    assert.equal(JSON.stringify(body).includes('Joiner@2026'), false);

    await request(app)
      .post('/api/auth/login')
      .send({ email: person.email, password: 'Joiner@2026' })
      .expect(200);
  });

  it('needs a password to add an employee', async () => {
    const agent = await signIn(await makeUser({ role: 'admin' }));
    const person = { name: 'No Password', email: 'nopass@example.com', employeeId: 'NEW-2' };

    await agent.post('/api/admin/employees').send(person).expect(400);
    assert.equal(await User.countDocuments({ email: person.email }), 0);
  });

  it('has no password link route any more', async () => {
    const agent = await signIn(await makeUser({ role: 'admin' }));
    const person = await makeUser();
    await agent.post(`/api/admin/employees/${person.id}/invite`).expect(404);
  });

  it('leaves admins out of the employee list', async () => {
    const admin = await makeUser({ role: 'admin', name: 'Head Admin' });
    await makeUser({ name: 'Regular Person' });
    const agent = await signIn(admin);

    const { body } = await agent.get('/api/admin/employees?status=all').expect(200);
    assert.deepEqual(body.items.map((user) => user.name), ['Regular Person']);
    assert.equal(body.total, 1);
  });

  it('keeps one active admin', async () => {
    const onlyAdmin = await makeUser({ role: 'admin' });
    const agent = await signIn(onlyAdmin);
    await agent.patch(`/api/admin/employees/${onlyAdmin.id}`).send({ isActive: false }).expect(409);
  });
});

describe('balance changes', () => {
  async function setup() {
    const person = await makeUser();
    const employee = await signIn(person);
    const admin = await signIn(await makeUser({ role: 'admin' }));
    const base = `/api/admin/employees/${person.id}/adjustments`;
    await BalanceAdjustment.deleteMany({});
    const { body } = await admin
      .post(base)
      .send({ leaveTypeId: casual.id, year: YEAR, days: 2, reason: 'Worked on Sunday' })
      .expect(201);
    return { employee, admin, url: `${base}/${body.adjustment.id}` };
  }

  const casualRow = (summary) => summary.balances.find((balance) => balance.leaveType.code === 'CL');
  const getSummary = async (agent) => (await agent.get(`/api/me/summary?year=${YEAR}`).expect(200)).body;

  it('adds an adjustment to what is available, not to the total', async () => {
    const { employee } = await setup();
    await apply(employee, { from: '2031-03-03', to: '2031-03-03' }).expect(201);
    const row = casualRow(await getSummary(employee));
    // Casual has a quota of 3; the admin added 2; one day is pending.
    assert.deepEqual([row.total, row.adjusted, row.booked, row.available], [3, 2, 1, 4]);
  });

  it('shows a banner until the employee closes it, and again after an edit', async () => {
    const { employee, admin, url } = await setup();

    let summary = await getSummary(employee);
    assert.equal(summary.adjustments.length, 1);
    assert.equal(summary.adjustments[0].reason, 'Worked on Sunday');
    assert.equal(casualRow(summary).available, 5);

    await employee.patch(`/api/me/adjustments/${summary.adjustments[0].id}/dismiss`).expect(204);
    summary = await getSummary(employee);
    assert.equal(summary.adjustments.length, 0);
    assert.equal(casualRow(summary).available, 5);

    await admin.patch(url).send({ days: 1, reason: 'Half of that was a mistake' }).expect(200);
    summary = await getSummary(employee);
    assert.equal(summary.adjustments.length, 1);
    assert.equal(summary.adjustments[0].days, 1);
    assert.equal(casualRow(summary).available, 4);
  });

  it('lets an admin remove a change', async () => {
    const { employee, admin, url } = await setup();
    await admin.delete(url).expect(204);

    const summary = await getSummary(employee);
    assert.equal(summary.adjustments.length, 0);
    assert.equal(casualRow(summary).available, 3);
    await admin.delete(url).expect(404);
  });

  it('will not remove days the employee has already booked', async () => {
    const { employee, admin, url } = await setup();
    await apply(employee, { from: '2031-03-03', to: '2031-03-07' }).expect(201);

    const blocked = await admin.delete(url);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.message, /already booked/);
    await admin.patch(url).send({ days: 1, reason: 'Trying to reduce' }).expect(409);
  });

  it('stays closed to employees, and an employee cannot close someone else\'s banner', async () => {
    const { employee, admin, url } = await setup();
    await employee.patch(url).send({ days: 9, reason: 'Giving myself days' }).expect(403);
    await employee.delete(url).expect(403);

    const other = await signIn(await makeUser());
    const { adjustments } = await getSummary(employee);
    await other.patch(`/api/me/adjustments/${adjustments[0].id}/dismiss`).expect(204);
    assert.equal((await getSummary(employee)).adjustments.length, 1);
    await admin.delete(url).expect(204);
  });
});

describe('notifications', () => {
  it('is empty after mark all read', async () => {
    const employee = await signIn(await makeUser());
    const admin = await signIn(await makeUser({ role: 'admin' }));
    await apply(employee, { from: '2031-03-03', to: '2031-03-03' }).expect(201);

    let body = {};
    for (let i = 0; i < 20 && !body.unread; i += 1) {
      ({ body } = await admin.get('/api/notifications'));
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    assert.equal(body.items.length, 1);

    await admin.patch('/api/notifications/read-all').expect(204);
    ({ body } = await admin.get('/api/notifications').expect(200));
    assert.equal(body.items.length, 0);
    assert.equal(body.unread, 0);
  });
});

describe('admin schedule', () => {
  it('lists the team and holidays, for admins only', async () => {
    await Holiday.create({ name: 'Spring Day', date: parseDay('2031-03-20') });
    const employee = await signIn(await makeUser({ name: 'Asha Rao' }));
    const admin = await signIn(await makeUser({ role: 'admin' }));
    await apply(employee, { from: '2031-03-03', to: '2031-03-03' }).expect(201);

    await employee.get('/api/admin/schedule').expect(403);
    const { body } = await admin.get(`/api/admin/schedule?year=${YEAR}`).expect(200);
    assert.deepEqual(body.upcoming.map((entry) => entry.title), ['Asha Rao', 'Spring Day']);
    assert.match(body.upcoming[0].detail, /Casual, 1 day\. Family function/);
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

describe('mail signature details', () => {
  it('lets people edit their own name, phone, designation and department only', async () => {
    const person = await makeUser();
    const employee = await signIn(person);
    const { body } = await employee
      .patch('/api/me/profile')
      .send({ name: 'New Name', phone: '+91 98765 43210', designation: 'Senior Analyst', department: 'Content' })
      .expect(200);
    assert.deepEqual(
      [body.user.name, body.user.phone, body.user.designation, body.user.department],
      ['New Name', '+91 98765 43210', 'Senior Analyst', 'Content'],
    );
    assert.ok(body.user.createdAt, 'the joined date comes with the profile');

    await employee.patch('/api/me/profile').send({ phone: '<b>1</b>' }).expect(400);
    await employee.patch('/api/me/profile').send({ name: 'x' }).expect(400);
    await employee.patch('/api/me/profile').send({ email: 'other@example.com' }).expect(400);
    await employee.patch('/api/me/profile').send({ role: 'admin' }).expect(400);
    await employee.patch('/api/me/profile').send({ employeeId: 'CON-999' }).expect(400);

    const fresh = await User.findById(person._id);
    assert.deepEqual([fresh.email, fresh.role, fresh.employeeId], [person.email, 'employee', person.employeeId]);
  });

  it('keeps the mail thread id out of API answers', async () => {
    const agent = await signIn(await makeUser());
    const { body } = await apply(agent, { from: '2031-04-01', to: '2031-04-01' }).expect(201);
    assert.equal('mailMessageId' in body.leave, false);
    const stored = await Leave.findById(body.leave.id).select('+mailMessageId');
    assert.match(stored.mailMessageId, /^<leave\..+@.+>$/);
  });
});

describe('leave mail text and CC', () => {
  it('gives the apply form a draft that follows the dates', async () => {
    const agent = await signIn(await makeUser());
    const { body } = await agent
      .post('/api/leaves/preview')
      .send({ leaveTypeId: casual.id, from: '2031-04-07', to: '2031-04-08' })
      .expect(200);
    assert.match(body.sentence, /two days of leave .* on \(07\/04\/2031 and 08\/04\/2031\)/);
    assert.match(body.draft, /due to \[reason\]\./);
  });

  it('saves the mail, To and CC, and refuses bad input', async () => {
    await makeUser({ role: 'admin' });
    const me = await makeUser();
    const agent = await signIn(me);
    const message = 'Hi Sir,\n\nI would like to request one day of leave due to a family function.\n\nThanks & Regards,\nMe';
    const day = { reason: undefined, from: '2031-04-14', to: '2031-04-14', message };

    await apply(agent, { ...day, cc: ['not-an-address'] }).expect(400);
    await apply(agent, { ...day, mailTo: [] }).expect(400);
    await apply(agent, { ...day, mailTo: [me.email] }).expect(400);
    await apply(agent, { ...day, message: message.replace('a family function', '[reason]') }).expect(400);
    await apply(agent, { ...day, subject: 'Leave\r\nBcc: x@y.z' }).expect(400);

    const { body } = await apply(agent, {
      ...day,
      subject: 'Leave for a family function',
      mailTo: ['Lead@Example.com'],
      cc: ['lead@example.com', 'typed.by.hand@example.org', me.email],
    }).expect(201);
    assert.equal(body.leave.to, '2031-04-14', 'the end date is untouched');
    assert.equal(body.leave.subject, 'Leave for a family function');
    assert.deepEqual(body.leave.mailTo, ['lead@example.com']);
    assert.deepEqual(body.leave.cc, ['typed.by.hand@example.org']);
    assert.equal(body.leave.message, message);
    assert.equal(body.leave.reason, 'a family function');
  });

  it('saves a pasted signature without anything unsafe', async () => {
    const agent = await signIn(await makeUser());
    const pasted =
      '<div style="color:#333;position:fixed"><b>Ravi</b><br><img src="https://example.com/logo.png" onerror="alert(1)">' +
      '<img src="http://example.com/x.png"><img src="https://mail.google.com/mail/u/0?ui=2&attid=0.1">' +
      '<img src="https://ci3.googleusercontent.com/meips/logo.png"><a href="javascript:alert(1)">bad</a> <a href="https://example.com">site</a>' +
      '<script>alert(1)</script><form action="https://evil.test"><input name="p"></form></div>';
    const { body } = await agent.patch('/api/me/profile').send({ signatureHtml: pasted }).expect(200);
    const saved = body.user.signatureHtml;
    assert.match(saved, /<b>Ravi<\/b>/);
    assert.match(saved, /<img src="https:\/\/example.com\/logo.png" \/>/);
    assert.match(saved, /href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/);
    assert.match(saved, /<img src="https:\/\/ci3.googleusercontent.com\/meips\/logo.png" \/>/);
    assert.equal((saved.match(/<img/g) ?? []).length, 2, 'pictures without a usable https link are dropped');
    for (const unsafe of ['onerror', 'script', 'javascript:', 'http://example.com/x.png', 'mail.google.com', '<form', '<input', 'position']) {
      assert.equal(saved.includes(unsafe), false, unsafe);
    }

    const { body: compose } = await agent.get('/api/me/compose').expect(200);
    assert.equal(compose.signature.customHtml, saved);

    // The app sends it gzipped, which the hosting firewall lets through.
    const packed = gzipSync(Buffer.from(pasted)).toString('base64');
    const { body: unpacked } = await agent.patch('/api/me/profile').send({ signatureGzip: packed }).expect(200);
    assert.equal(unpacked.user.signatureHtml, saved);
    await agent.patch('/api/me/profile').send({ signatureGzip: 'bm90IGd6aXA=' }).expect(400);
    await agent.patch('/api/me/profile').send({ signatureGzip: '<b>x</b>' }).expect(400);
    const bomb = gzipSync(Buffer.alloc(5_000_000, 'a')).toString('base64');
    await agent.patch('/api/me/profile').send({ signatureGzip: bomb }).expect(400);
    const { body: reset } = await agent.patch('/api/me/profile').send({ signatureHtml: '' }).expect(200);
    assert.equal(reset.user.signatureHtml, '');
  });

  it('trims blank lines and extra space from a pasted signature, even a long one', async () => {
    const agent = await signIn(await makeUser());
    const blank = '<div><br></div><div>&nbsp;</div><p> </p>\n\n';
    // Gmail repeats a long style on every piece, and leaves empty tags behind.
    const style = 'font-family:Arial,Helvetica,sans-serif;font-size:13px;color:rgb(34,34,34);line-height:18px;margin:0px;padding:0px';
    const lines = Array.from(
      { length: 120 },
      (_, i) => `<div style="${style}"><span style="${style}">Line   ${i}</span><span style="${style}"></span><font>  </font></div>`,
    ).join('\n');
    const pasted = `${blank.repeat(5)}${lines}${blank.repeat(5)}`;
    assert.ok(pasted.length > 20000, 'longer than the old limit');

    const packed = gzipSync(Buffer.from(pasted)).toString('base64');
    const { body } = await agent.patch('/api/me/profile').send({ signatureGzip: packed }).expect(200);
    const saved = body.user.signatureHtml;
    assert.match(saved, /^<div style="[^"]+"><span style="[^"]+">Line 0<\/span><\/div>/, 'no blank lines at the start');
    assert.match(saved, /Line 119<\/span><\/div>$/, 'no blank lines at the end');
    assert.equal(saved.includes('<font>'), false, 'empty tags are gone');
    assert.equal(/\s{2,}/.test(saved), false, 'no runs of spaces');

    const middle = (await agent.patch('/api/me/profile').send({ signatureHtml: `<b>A</b>${blank.repeat(4)}<b>B</b>` }).expect(200)).body;
    assert.equal(middle.user.signatureHtml, '<b>A</b><br><br><b>B</b>', 'many blank lines become one');
  });

  it('stores the admin reply and uses it as the rejection reason', async () => {
    const employee = await signIn(await makeUser());
    const admin = await signIn(await makeUser({ role: 'admin' }));
    const { body } = await apply(employee, { from: '2031-04-21', to: '2031-04-21' }).expect(201);
    const reply = 'Hi there,\n\nNot this week, the release is on.\n\nThanks,\nBoss';
    const { body: reviewed } = await admin
      .patch(`/api/admin/leaves/${body.leave.id}/review`)
      .send({ decision: 'rejected', reply })
      .expect(200);
    assert.equal(reviewed.leave.reply, reply);
    assert.equal(reviewed.leave.reviewNote, 'Not this week, the release is on.');
  });

  it('tells the compose box who the mail goes to and the signature', async () => {
    await makeUser({ role: 'admin', name: 'Compose Admin' });
    const agent = await signIn(await makeUser({ phone: '+91 90000 11111' }));
    const { body } = await agent.get('/api/me/compose').expect(200);
    assert.ok(body.to.some((person) => person.name === 'Compose Admin'));
    assert.equal(body.signature.phone, '+91 90000 11111');
    assert.equal(body.signature.designation, 'Analyst');
    assert.ok(Array.isArray(body.contacts));
  });
});

describe('hidden test accounts', () => {
  it('can use the app but nobody else sees them or their leave', async () => {
    const admin = await signIn(await makeUser({ role: 'admin' }));
    const colleague = await signIn(await makeUser({ name: 'Visible Person' }));
    const tester = await makeUser({ name: 'Hidden Tester', hidden: true });
    const testerAgent = await signIn(tester);

    const { body } = await apply(testerAgent, { from: '2031-05-05', to: '2031-05-05' }).expect(201);
    await apply(colleague, { from: '2031-05-06', to: '2031-05-06' }).expect(201);

    const employees = await admin.get('/api/admin/employees').expect(200);
    assert.equal(employees.body.items.some((person) => person.name === 'Hidden Tester'), false);
    assert.ok(employees.body.items.some((person) => person.name === 'Visible Person'));

    const requests = await admin.get('/api/admin/leaves?status=pending').expect(200);
    assert.equal(requests.body.items.some((leave) => leave.id === body.leave.id), false);
    assert.equal(requests.body.total, 1);
    const search = await admin.get('/api/admin/leaves?q=Hidden').expect(200);
    assert.equal(search.body.total, 0);

    const overview = await admin.get('/api/admin/overview').expect(200);
    assert.equal(overview.body.pendingCount, 1);

    const calendar = await colleague.get('/api/team-calendar?month=2031-05').expect(200);
    assert.equal(calendar.body.leaves.some((leave) => leave.name === 'Hidden Tester'), false);
    assert.equal(calendar.body.leaves.length, 1);

    const compose = await colleague.get('/api/me/compose').expect(200);
    assert.equal(compose.body.contacts.some((contact) => contact.email === tester.email), false);

    const notes = await admin.get('/api/notifications').expect(200);
    assert.equal(notes.body.items.some((note) => note.title.includes('Hidden Tester')), false);
    assert.ok(notes.body.items.some((note) => note.title.includes('Visible Person')));

    const own = await testerAgent.get('/api/me/leaves').expect(200);
    assert.equal(own.body.items.length, 1, 'the tester still sees their own leave');
  });
});

describe('admin records a leave someone took', () => {
  it('saves it as approved on that day and takes it off what is available', async () => {
    const person = await makeUser({ name: 'Missed Applier' });
    const employee = await signIn(person);
    const admin = await signIn(await makeUser({ role: 'admin' }));
    const url = `/api/admin/employees/${person.id}/leaves`;

    const { body } = await admin
      .post(url)
      .send({ leaveTypeId: casual.id, from: '2031-03-03', to: '2031-03-03', session: 'first', note: 'Forgot to apply' })
      .expect(201);
    assert.deepEqual(
      [body.leave.status, body.leave.days, body.leave.from, body.leave.session, body.leave.reason],
      ['approved', 0.5, '2031-03-03', 'first', 'Forgot to apply'],
    );
    assert.ok(body.leave.recordedBy);

    const summary = (await employee.get(`/api/me/summary?year=${YEAR}`).expect(200)).body;
    const row = summary.balances.find((balance) => balance.leaveType.code === 'CL');
    assert.deepEqual([row.approved, row.available], [0.5, 2.5]);

    const notes = (await employee.get('/api/notifications').expect(200)).body;
    assert.ok(notes.items.some((note) => note.title.includes('recorded')));

    // On the employee page it shows under the year's leave and the balance changes.
    const page = (await admin.get(`/api/admin/employees/${person.id}?year=${YEAR}`).expect(200)).body;
    assert.deepEqual(page.recent.map((leave) => leave.id), [body.leave.id]);
    assert.deepEqual(page.recorded.map((leave) => leave.id), [body.leave.id]);
    assert.ok(page.recorded[0].recordedBy.name);
  });

  it('lists only approved leave for the year, and can take back a recorded one', async () => {
    const person = await makeUser({ name: 'Mixed Leave' });
    const employee = await signIn(person);
    const admin = await signIn(await makeUser({ role: 'admin' }));
    const applied = (await employee.post('/api/leaves').send({ leaveTypeId: casual.id, from: '2031-04-01', to: '2031-04-01', reason: 'Family function' }).expect(201)).body.leave;
    const recorded = (await admin.post(`/api/admin/employees/${person.id}/leaves`).send({ leaveTypeId: casual.id, from: '2031-04-02', to: '2031-04-02' }).expect(201)).body.leave;

    let page = (await admin.get(`/api/admin/employees/${person.id}?year=${YEAR}`).expect(200)).body;
    assert.deepEqual(page.recent.map((leave) => leave.id), [recorded.id], 'the pending one is not listed yet');

    // Only recorded leave can be taken back here, and only by an admin.
    await admin.delete(`/api/admin/employees/${person.id}/leaves/${applied.id}`).expect(404);
    await employee.delete(`/api/admin/employees/${person.id}/leaves/${recorded.id}`).expect(403);
    await admin.delete(`/api/admin/employees/${person.id}/leaves/${recorded.id}`).expect(204);
    await admin.delete(`/api/admin/employees/${person.id}/leaves/${recorded.id}`).expect(404);

    page = (await admin.get(`/api/admin/employees/${person.id}?year=${YEAR}`).expect(200)).body;
    assert.deepEqual([page.recent.length, page.recorded.length], [0, 0]);
    const row = page.balances.find((balance) => balance.leaveType.code === 'CL');
    assert.equal(row.approved, 0, 'the day is back in the balance');
  });

  it('keeps the usual checks and names the person in the message', async () => {
    const person = await makeUser({ name: 'Missed Applier' });
    const employee = await signIn(person);
    const admin = await signIn(await makeUser({ role: 'admin' }));
    const url = `/api/admin/employees/${person.id}/leaves`;

    await admin.post(url).send({ leaveTypeId: casual.id, from: '2031-03-02', to: '2031-03-02' }).expect(400); // a Sunday
    await admin.post(url).send({ leaveTypeId: casual.id, from: '2031-03-04', to: '2031-03-04' }).expect(201);
    const overlap = await admin.post(url).send({ leaveTypeId: casual.id, from: '2031-03-04', to: '2031-03-04' }).expect(409);
    assert.match(overlap.body.message, /^Missed Applier already has leave/);

    await admin.post(url).send({ leaveTypeId: casual.id, from: '2031-03-05', to: '2031-03-05' }).expect(201);
    await admin.post(url).send({ leaveTypeId: casual.id, from: '2031-03-06', to: '2031-03-06' }).expect(201);
    const tooMany = await admin.post(url).send({ leaveTypeId: casual.id, from: '2031-03-07', to: '2031-03-07' }).expect(409);
    assert.match(tooMany.body.message, /^Missed Applier has 0 Casual left/);

    await employee.post(url).send({ leaveTypeId: casual.id, from: '2031-03-10', to: '2031-03-10' }).expect(403);
  });
});

describe('admin records several days of leave', () => {
  it('counts working days only, shows them first, and takes them off', async () => {
    const person = await makeUser({ name: 'Range Person' });
    const employee = await signIn(person);
    const admin = await signIn(await makeUser({ role: 'admin' }));
    const url = `/api/admin/employees/${person.id}/leaves`;

    // Saturday 8 March to Monday 10 March 2031: Sunday is not counted.
    const preview = await admin.post(`${url}/preview`).send({ leaveTypeId: casual.id, from: '2031-03-08', to: '2031-03-10' }).expect(200);
    assert.deepEqual([preview.body.days, preview.body.availableAfter], [2, 1]);

    const { body } = await admin.post(url).send({ leaveTypeId: casual.id, from: '2031-03-08', to: '2031-03-10' }).expect(201);
    assert.deepEqual([body.leave.from, body.leave.to, body.leave.days], ['2031-03-08', '2031-03-10', 2]);

    await admin.post(url).send({ leaveTypeId: casual.id, from: '2031-03-11', to: '2031-03-12', session: 'first' }).expect(400);
    await admin.post(`${url}/preview`).send({ leaveTypeId: casual.id, from: '2031-03-11', to: '2031-03-12' }).expect(409);
    const lwp_ = await admin.post(url).send({ leaveTypeId: lwp.id, from: '2031-03-11', to: '2031-03-12' }).expect(201);
    assert.equal(lwp_.body.leave.days, 2, 'leave without pay has no limit');

    const row = (await employee.get(`/api/me/summary?year=${YEAR}`).expect(200)).body.balances.find((b) => b.leaveType.code === 'CL');
    assert.equal(row.available, 1);
  });
});

describe('team page', () => {
  it('lists active people with today\'s leave, and leaves out hidden and inactive ones', async () => {
    const { todayString } = await import('../src/utils/dates.js');
    const today = parseDay(todayString('Asia/Kolkata'));
    const viewer = await makeUser({ name: 'Team Viewer', designation: 'Senior Analyst', phone: '+91 90000 00009' });
    const away = await makeUser({ name: 'Away Person' });
    const unpaid = await makeUser({ name: 'Unpaid Person', department: 'Research' });
    await makeUser({ name: 'Boss', role: 'admin' });
    await makeUser({ name: 'Hidden Tester', hidden: true });
    await makeUser({ name: 'Gone Person', isActive: false });

    await Leave.create([
      { user: away._id, leaveType: casual._id, from: today, to: today, days: 1, year: today.getUTCFullYear(), reason: 'x', status: 'approved' },
      { user: unpaid._id, leaveType: lwp._id, from: today, to: today, days: 1, year: today.getUTCFullYear(), reason: 'x', status: 'approved' },
    ]);

    const agent = await signIn(viewer);
    const { body } = await agent.get('/api/team').expect(200);
    const byName = Object.fromEntries(body.members.map((member) => [member.name, member]));

    assert.deepEqual(Object.keys(byName).sort(), ['Away Person', 'Boss', 'Team Viewer', 'Unpaid Person']);
    assert.equal(body.location, 'Bhubaneswar');
    assert.deepEqual(body.departments, ['Content Integration', 'Research']);
    assert.deepEqual(
      [byName['Team Viewer'].designation, byName['Team Viewer'].phone, byName['Away Person'].designation, byName['Away Person'].department],
      ['Senior Analyst', '+91 90000 00009', 'Analyst', 'Content Integration'],
    );
    assert.equal(byName['Team Viewer'].leave, null);
    assert.deepEqual([byName['Away Person'].leave.type, byName['Away Person'].leave.unpaid], ['Casual', false]);
    assert.equal(byName['Unpaid Person'].leave.unpaid, true);
    assert.equal('passwordHash' in byName['Boss'], false);

    await request(app).get('/api/team').expect(401);
  });
});
