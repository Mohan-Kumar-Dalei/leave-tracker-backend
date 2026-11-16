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
const { default: Department } = await import('../src/models/Department.js');
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

// HR is turned off for now; a manager organises the departments they run.
async function organiser() {
  const user = await makeUser({ role: 'admin', name: 'Org Manager', department: 'Head Office', designation: 'Manager' });
  await Department.create({ name: 'Head Office', manager: user._id });
  return signIn(user);
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

  it('clears read notifications an hour after reading and keeps unread ones', async () => {
    const { default: Notification, READ_KEEP_SECONDS } = await import('../src/models/Notification.js');
    await Notification.syncIndexes();
    const indexes = await Notification.collection.indexes();
    const onRead = indexes.find((index) => index.key.readAt === 1);
    assert.equal(READ_KEEP_SECONDS, 3600);
    assert.equal(onRead?.expireAfterSeconds, 3600, 'MongoDB removes them an hour after readAt');
    // An index on readAt skips documents without it, so unread ones are never touched.
    const onCreated = indexes.find((index) => index.key.createdAt === 1 && index.expireAfterSeconds);
    assert.equal(onCreated?.expireAfterSeconds, 60 * 60 * 24 * 180, 'unread ones still go after 180 days');
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

  it("adds the leave type's total, applied and available days to both exports", async () => {
    const person = await makeUser();
    const employee = await signIn(person);
    const admin = await signIn(await makeUser({ role: 'admin' }));
    // Casual has 3 days a year; this asks for 2, leaving 1.
    await apply(employee, { from: '2031-03-03', to: '2031-03-04' }).expect(201);

    // Every cell is quoted; drop the quotes to compare.
    const lines = (text) => text.replace(/^﻿/, '').replaceAll('"', '').split('\r\n');

    const adminCsv = lines((await admin.get(`/api/admin/leaves.csv?user=${person.id}`).expect(200)).text);
    assert.match(adminCsv[0], /,Year,Total leave,Applied,Available$/);
    assert.equal(adminCsv.length, 2);
    assert.match(adminCsv[1], /,2031,3,2,1$/);

    const ownCsv = lines((await employee.get('/api/me/leaves.csv?year=2031').expect(200)).text);
    assert.match(ownCsv[0], /,Total leave,Applied,Available$/);
    assert.match(ownCsv[1], /,3,2,1$/);
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

  it('accepts Reply all, which quotes the employee mail under the reply', async () => {
    const employee = await signIn(await makeUser());
    const admin = await signIn(await makeUser({ role: 'admin' }));
    const { body } = await apply(employee, { from: '2031-04-22', to: '2031-04-22' }).expect(201);
    await admin
      .patch(`/api/admin/leaves/${body.leave.id}/review`)
      .send({ decision: 'approved', reply: 'Hi there,\n\nApproved.\n\nThanks', quoteOriginal: 'yes' })
      .expect(400);
    const { body: reviewed } = await admin
      .patch(`/api/admin/leaves/${body.leave.id}/review`)
      .send({ decision: 'approved', reply: 'Hi there,\n\nApproved.\n\nThanks', quoteOriginal: true })
      .expect(200);
    assert.equal(reviewed.leave.status, 'approved');
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

  it('keeps who reports to whom, set by an admin, without loops', async () => {
    const boss = await makeUser({ name: 'Tree Boss', role: 'admin' });
    const lead = await makeUser({ name: 'Tree Lead' });
    const member = await makeUser({ name: 'Tree Member' });
    const admin = await signIn(boss);
    const url = (person) => `/api/admin/employees/${person.id}`;

    await admin.patch(url(lead)).send({ reportsTo: boss.id }).expect(200);
    await admin.patch(url(member)).send({ reportsTo: lead.id, workFromHome: true }).expect(200);
    const self = await admin.patch(url(member)).send({ reportsTo: member.id }).expect(400);
    assert.match(self.body.message, /themselves/);
    const loop = await admin.patch(url(boss)).send({ reportsTo: member.id }).expect(400);
    assert.match(loop.body.message, /loop/);

    const employee = await signIn(member);
    await employee.patch(url(member)).send({ reportsTo: boss.id }).expect(403);
    const { body } = await employee.get('/api/team').expect(200);
    const byName = Object.fromEntries(body.members.map((m) => [m.name, m]));
    assert.equal(byName['Tree Member'].reportsTo, lead.id);
    assert.equal(byName['Tree Member'].workFromHome, true);
    assert.equal(byName['Tree Lead'].reportsTo, boss.id);
    assert.equal(byName['Tree Boss'].reportsTo, null);

    // Nobody: back to the top of the department.
    await admin.patch(url(member)).send({ reportsTo: null }).expect(200);
  });
});

describe('organisation', () => {

  beforeEach(async () => {
    await Department.init();
    await Department.deleteMany({});
  });

  it('is for managers only', async () => {
    const employee = await signIn(await makeUser());
    const admin = await signIn(await makeUser({ role: 'admin' }));
    await employee.get('/api/org').expect(403);
    await admin.get('/api/org').expect(403);
    await request(app).get('/api/org').expect(401);
    const manager = await organiser();
    await manager.get('/api/org').expect(200);
  });

  it('keeps HR accounts turned off: no sign-in and not in the team', async () => {
    const hr = await makeUser({ role: 'owner', name: 'Old HR' });
    await request(app).post('/api/auth/login').send({ email: hr.email, password: PASSWORD }).expect(401);
    const someone = await signIn(await makeUser());
    const team = (await someone.get('/api/team').expect(200)).body;
    assert.ok(!team.members.some((member) => member.name === 'Old HR'));
    assert.ok(!team.departments.includes('HR'));
  });

  it('adds, renames and removes departments', async () => {
    const owner = await organiser();
    const { body } = await owner.post('/api/org/departments').send({ name: 'Sales', location: 'Delhi' }).expect(201);
    await owner.post('/api/org/departments').send({ name: 'sales' }).expect(409);

    const person = await makeUser({ department: 'Sales' });
    await owner.patch(`/api/org/departments/${body.department.id}`).send({ name: 'Inside Sales' }).expect(200);
    assert.equal((await User.findById(person.id)).department, 'Inside Sales');

    await owner.delete(`/api/org/departments/${body.department.id}`).expect(409);
    await User.updateOne({ _id: person.id }, { department: 'Elsewhere' });
    await owner.delete(`/api/org/departments/${body.department.id}`).expect(204);
  });

  it('sets one department lead and moves employees between departments', async () => {
    const owner = await organiser();
    const sales = (await owner.post('/api/org/departments').send({ name: 'Sales' }).expect(201)).body.department;
    const lead = await makeUser({ department: 'Sales' });
    await owner.patch(`/api/org/departments/${sales.id}`).send({ lead: lead.id }).expect(200);
    const hr = (await owner.post('/api/org/departments').send({ name: 'HR' }).expect(201)).body.department;

    let org = (await owner.get('/api/org').expect(200)).body;
    assert.equal(org.departments.find((d) => d.name === 'Sales').lead.id, lead.id);

    await owner.patch(`/api/org/departments/${sales.id}`).send({ lead: null }).expect(200);
    await owner
      .patch(`/api/org/departments/${sales.id}`)
      .send({ lead: new mongoose.Types.ObjectId().toString() })
      .expect(400);
    org = (await owner.get('/api/org').expect(200)).body;
    assert.equal(org.departments.find((d) => d.name === 'Sales').lead, null);

    const seller = await makeUser({ department: 'Sales' });
    await owner.patch(`/api/org/people/${seller.id}`).send({ department: hr.id }).expect(200);
    assert.equal((await User.findById(seller.id)).department, 'HR');
  });

  it('adds an employee with the first-name@year starting password', async () => {
    const owner = await organiser();
    const sales = (await owner.post('/api/org/departments').send({ name: 'Sales' }).expect(201)).body.department;
    const person = { name: 'Asha Rani Das', email: 'asha.das@example.com', designation: 'Assistant Manager' };

    const { body } = await owner.post('/api/org/people').send({ ...person, department: sales.id }).expect(201);
    const year = new Date().getFullYear();
    assert.equal(body.startingPassword, `Asha@${year}`);
    assert.equal(body.person.department, 'Sales');
    assert.equal(body.person.role, 'employee');

    await request(app).post('/api/auth/login').send({ email: person.email, password: `Asha@${year}` }).expect(200);
    await owner.post('/api/org/people').send({ ...person, department: sales.id }).expect(409);

    // They can now be the department lead.
    await owner.patch(`/api/org/departments/${sales.id}`).send({ lead: body.person.id }).expect(200);
  });

  it('invites the assistant manager, who brings in and approves the team', async () => {
    const owner = await organiser();
    const created = await owner
      .post('/api/org/departments')
      .send({ name: '3PP', managerName: 'Ravi Kumar', assistantName: 'Sita Das', assistantEmail: 'sita@example.com' })
      .expect(201);
    const dept = created.body.department;
    assert.equal(dept.managerName, 'Org Manager'); // the manager who added it runs it
    assert.equal(created.body.invites.length, 1);
    const inviteToken = created.body.invites[0].link.split('/join/invite/')[1];

    // The assistant manager accepts the invitation and creates their account.
    const invite = (await request(app).get(`/api/join/invite/${inviteToken}`).expect(200)).body;
    assert.equal(invite.role, 'assistant');
    assert.equal(invite.email, 'sita@example.com');
    const sitaPassword = 'sita-pass-123';
    await request(app)
      .post(`/api/join/invite/${inviteToken}`)
      .send({ name: 'Sita Das', password: sitaPassword })
      .expect(201);
    await request(app)
      .post(`/api/join/invite/${inviteToken}`)
      .send({ name: 'Sita Das', password: sitaPassword })
      .expect(409);

    const sita = request.agent(app);
    await sita.post('/api/auth/login').send({ email: 'sita@example.com', password: sitaPassword }).expect(200);
    const mine = (await sita.get('/api/departments/mine').expect(200)).body.items;
    assert.deepEqual(mine.map((item) => item.name), ['3PP']);
    const sitaId = String((await Department.findById(dept.id)).admins[0]);

    // Someone opens the join link and asks to join.
    const page = (await sita.get(`/api/departments/${dept.id}`).expect(200)).body;
    const code = page.joinLink.split('/join/')[1];
    assert.equal((await request(app).get(`/api/join/${code}`).expect(200)).body.department, '3PP');
    const amit = { name: 'Amit Rout', email: 'amit@example.com', designation: 'Analyst', password: 'amit-pass-123' };
    await request(app).post(`/api/join/${code}`).send(amit).expect(201);
    await request(app).post(`/api/join/${code}`).send(amit).expect(409);
    // Not an account until approved.
    await request(app).post('/api/auth/login').send({ email: amit.email, password: amit.password }).expect(401);

    // Someone outside the department cannot see or approve it.
    const outsider = await signIn(await makeUser());
    await outsider.get(`/api/departments/${dept.id}`).expect(403);

    const waiting = (await sita.get(`/api/departments/${dept.id}`).expect(200)).body.requests;
    assert.equal(waiting.length, 1);
    const approved = await sita.post(`/api/departments/${dept.id}/requests/${waiting[0].id}/approve`).expect(200);
    await request(app).post('/api/auth/login').send({ email: amit.email, password: amit.password }).expect(200);

    // The team reports to the assistant manager, as in Content Integration.
    assert.equal(String((await User.findById(approved.body.person.id)).reportsTo), sitaId);
    // Only the manager changes the assistant manager.
    await sita.put(`/api/departments/${dept.id}/assistant`).send({ user: approved.body.person.id }).expect(403);

    // The manager and the assistant manager both pick team leads and who
    // reports to them.
    const amitId = approved.body.person.id;
    const bina = await makeUser({ name: 'Bina Roy', department: '3PP', reportsTo: sitaId });
    await owner.patch(`/api/departments/${dept.id}/members/${bina.id}`).send({ reportsTo: amitId }).expect(400); // not a lead yet
    await sita.patch(`/api/departments/${dept.id}/members/${amitId}`).send({ teamLead: true }).expect(200);
    // Only the manager decides who reports to whom.
    await sita.patch(`/api/departments/${dept.id}/members/${bina.id}`).send({ reportsTo: amitId }).expect(403);
    assert.equal(String((await User.findById(bina.id)).reportsTo), sitaId);
    await owner.patch(`/api/departments/${dept.id}/members/${bina.id}`).send({ reportsTo: amitId }).expect(200);
    assert.equal(String((await User.findById(bina.id)).reportsTo), amitId);
    const members = (await sita.get(`/api/departments/${dept.id}`).expect(200)).body.members;
    assert.equal(members.find((person) => person.id === amitId).teamLead, true);
    await sita.patch(`/api/departments/${dept.id}/members/${sitaId}`).send({ teamLead: true }).expect(400);
    await outsider.patch(`/api/departments/${dept.id}/members/${amitId}`).send({ teamLead: false }).expect(403);
    // A team lead with a team stays one, and the tree does not change.
    await sita.patch(`/api/departments/${dept.id}/members/${amitId}`).send({ teamLead: false }).expect(409);
    await owner.patch(`/api/departments/${dept.id}/members/${amitId}`).send({ teamLead: false }).expect(409);
    assert.equal(String((await User.findById(bina.id)).reportsTo), amitId);

    // The manager chooses who the assistant manager is.
    await owner.put(`/api/departments/${dept.id}/assistant`).send({ user: amitId }).expect(200);
    assert.equal(String((await Department.findById(dept.id)).admins[0]), amitId);
  });
});

describe('leave inside the organisation', () => {
  beforeEach(async () => {
    await Department.init();
    await Department.deleteMany({});
  });

  async function acceptInvite(link, employeeId, password) {
    const token = link.split('/join/invite/')[1];
    const { body } = await request(app).get(`/api/join/invite/${token}`).expect(200);
    await request(app).post(`/api/join/invite/${token}`).send({ name: body.name, password }).expect(201);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: body.email, password }).expect(200);
    return agent;
  }

  it('sends each request to the right person and keeps each admin to their department', async () => {
    // Content Integration as it is today: one admin and an employee.
    const oldAdmin = await signIn(await makeUser({ role: 'admin', name: 'Old Admin' }));
    const ciEmployee = await makeUser({ name: 'CI Person' });

    // Ravi registers as the manager of Sales and invites Sita as the AM.
    await request(app)
      .post('/api/join/manager')
      .send({ name: 'Ravi Kumar', email: 'ravi@example.com', department: 'Sales', password: 'ravi-pass-12345' })
      .expect(201);
    const ravi = request.agent(app);
    await ravi.post('/api/auth/login').send({ email: 'ravi@example.com', password: 'ravi-pass-12345' }).expect(200);
    const salesDept = await Department.findOne({ name: 'Sales' });
    const invited = await ravi
      .post(`/api/departments/${salesDept.id}/assistant-invite`)
      .send({ name: 'Sita Das', email: 'sita@example.com' })
      .expect(201);
    const sita = await acceptInvite(invited.body.invite.link, 'S-001', 'sita-pass-123');
    const hr = ravi; // the manager sees the whole department
    const created = { body: { department: { id: salesDept.id } } };
    assert.equal((await User.findOne({ email: 'sita@example.com' })).role, 'admin');
    assert.equal((await User.findOne({ email: 'ravi@example.com' })).role, 'admin');

    const added = await hr
      .post('/api/org/people')
      .send({ name: 'Amit Rout', email: 'amit@example.com', department: created.body.department.id })
      .expect(201);
    const amit = request.agent(app);
    await amit.post('/api/auth/login').send({ email: 'amit@example.com', password: added.body.startingPassword }).expect(200);

    // Who each person's request goes to.
    const toOf = async (agent) => (await agent.get('/api/me/compose').expect(200)).body.to.map((person) => person.email);
    assert.deepEqual(await toOf(amit), ['sita@example.com']);
    assert.deepEqual(await toOf(sita), ['ravi@example.com']);
    assert.equal((await toOf(ravi)).length, 0); // nobody above a manager while HR is off

    // The employee's request is Sita's to decide, not the other department's admin.
    const amitLeave = (await apply(amit, { from: '2031-03-03', to: '2031-03-03' }).expect(201)).body.leave;
    const pendingFor = async (agent) =>
      (await agent.get('/api/admin/leaves?status=pending').expect(200)).body.items.map((item) => item.id);
    assert.deepEqual(await pendingFor(sita), [amitLeave.id]);
    assert.deepEqual(await pendingFor(oldAdmin), []);
    assert.deepEqual(await pendingFor(hr), [amitLeave.id]);
    // HR sees where it came from and who it went to, and can pick the department.
    const hrView = (await hr.get('/api/admin/leaves?status=pending&department=Sales').expect(200)).body;
    assert.equal(hrView.items[0].department, 'Sales');
    assert.deepEqual(hrView.items[0].reportedTo, ['Sita Das']);
    assert.ok(hrView.departments.includes('Sales'));
    assert.equal((await hr.get('/api/admin/leaves?status=pending&department=Other').expect(200)).body.items.length, 0);
    await oldAdmin.patch(`/api/admin/leaves/${amitLeave.id}/review`).send({ decision: 'approved' }).expect(404);
    await sita.patch(`/api/admin/leaves/${amitLeave.id}/review`).send({ decision: 'approved' }).expect(200);

    // Sita's own leave is the manager's to decide.
    const sitaLeave = (await apply(sita, { from: '2031-03-04', to: '2031-03-04' }).expect(201)).body.leave;
    await sita.patch(`/api/admin/leaves/${sitaLeave.id}/review`).send({ decision: 'approved' }).expect(403);
    await ravi.patch(`/api/admin/leaves/${sitaLeave.id}/review`).send({ decision: 'approved' }).expect(200);
    const raviLeave = (await apply(ravi, { from: '2031-03-05', to: '2031-03-05' }).expect(201)).body.leave;
    await sita.patch(`/api/admin/leaves/${raviLeave.id}/review`).send({ decision: 'approved' }).expect(403);
    // With HR off there is nobody above the manager, so they decide their own.
    await ravi.patch(`/api/admin/leaves/${raviLeave.id}/review`).send({ decision: 'approved' }).expect(200);

    // Employees and their pages stay within the department.
    const names = async (agent) => (await agent.get('/api/admin/employees').expect(200)).body.items.map((item) => item.name);
    assert.deepEqual((await names(sita)).sort(), ['Amit Rout', 'Ravi Kumar']);
    assert.ok(!(await names(oldAdmin)).includes('Amit Rout'));
    assert.ok((await names(oldAdmin)).includes('CI Person'));
    await oldAdmin.get(`/api/admin/employees/${added.body.person.id}`).expect(404);
    await sita.get(`/api/admin/employees/${ciEmployee.id}`).expect(404);

    // Only HR decides who is an admin.
    await sita
      .post('/api/admin/employees')
      .send({ name: 'New One', email: 'new.one@example.com', role: 'admin', password: 'new-pass-1234' })
      .expect(403);
  });
});

describe('registering on your own', () => {
  beforeEach(async () => {
    await Department.init();
    await Department.deleteMany({});
  });

  it('lets a manager register and organise their own departments, with HR sign-up closed', async () => {
    // HR cannot register for now.
    await request(app)
      .post('/api/join/owner')
      .send({ name: 'Neha HR', email: 'hr@example.com', password: 'hr-pass-12345' })
      .expect(403);
    assert.equal(await User.exists({ email: 'hr@example.com' }), null);

    // A manager registers with a new department and can sign in at once.
    const manager = { name: 'Ravi Kumar', email: 'ravi@example.com', department: 'Research', password: 'ravi-pass-12345' };
    await request(app).post('/api/join/manager').send(manager).expect(201);
    await request(app).post('/api/join/manager').send({ ...manager, email: 'r2@example.com' }).expect(409);
    const ravi = request.agent(app);
    const login = await ravi.post('/api/auth/login').send({ email: manager.email, password: manager.password }).expect(200);
    assert.equal(login.body.user.position, 'manager');
    const research = await Department.findOne({ name: 'Research' });
    assert.equal(String(research.manager), login.body.user.id);

    // Content Integration already exists, with its assistant manager and
    // team but no manager.
    const ciAm = await makeUser({ name: 'CI AM', role: 'admin', department: 'Content Integration' });
    const ciPerson = await makeUser({ name: 'CI Person', department: 'Content Integration', reportsTo: ciAm.id });
    await Department.create({ name: 'Content Integration', admins: [ciAm._id] });

    // The managers see the whole company.
    const added = await ravi.post('/api/org/departments').send({ name: 'Data', managerName: 'Someone Else' }).expect(201);
    assert.equal(String(added.body.department.manager), login.body.user.id);
    assert.equal(added.body.department.managerName, 'Ravi Kumar');
    let org = (await ravi.get('/api/org').expect(200)).body;
    assert.deepEqual(org.departments.map((item) => item.name).sort(), ['Content Integration', 'Data', 'Research']);
    assert.ok(org.people.some((person) => person.name === 'CI Person'));
    const ci = await Department.findOne({ name: 'Content Integration' });
    await ravi.delete(`/api/org/departments/${ci.id}`).expect(409); // it still has people

    // A second manager waits for an existing manager. Rajesh asks to manage
    // Content Integration; a department with a manager cannot be asked for.
    await request(app)
      .post('/api/join/manager')
      .send({ ...manager, email: 'r3@example.com', department: 'Research' })
      .expect(409);
    const rajesh = { name: 'Rajesh Swain', email: 'rajesh@example.com', department: 'content integration', password: 'rajesh-pass-123' };
    const asked = await request(app).post('/api/join/manager').send(rajesh).expect(201);
    assert.equal(asked.body.pending, true);
    await request(app).post('/api/auth/login').send({ email: rajesh.email, password: rajesh.password }).expect(401);
    org = (await ravi.get('/api/org').expect(200)).body;
    assert.equal(org.managerRequests.length, 1);
    await ravi.post(`/api/org/manager-requests/${org.managerRequests[0].id}/approve`).expect(200);

    // Rajesh now heads Content Integration: Rajesh, then the AM, then the team.
    const rajeshAgent = request.agent(app);
    const rajeshLogin = await rajeshAgent.post('/api/auth/login').send({ email: rajesh.email, password: rajesh.password }).expect(200);
    assert.equal(rajeshLogin.body.user.position, 'manager');
    const rajeshId = rajeshLogin.body.user.id;
    assert.equal(String((await Department.findById(ci.id)).manager), rajeshId);
    assert.equal(String((await User.findById(ciAm.id)).reportsTo), rajeshId);
    assert.equal(String((await User.findById(ciPerson.id)).reportsTo), ciAm.id);
    const team = (await rajeshAgent.get('/api/team').expect(200)).body;
    assert.equal(team.members.find((member) => member.name === 'CI AM').reportsTo, rajeshId);

    // A manager can also set who manages a department.
    await ravi.patch(`/api/org/departments/${added.body.department.id}`).send({ manager: rajeshId }).expect(200);
    assert.equal((await Department.findById(added.body.department.id)).managerName, 'Rajesh Swain');

    // An assistant manager or employee cannot open Organisation.
    const employee = await signIn(await makeUser({ department: 'Research' }));
    await employee.get('/api/org').expect(403);

    // The manager invites the assistant manager, who joins as admin.
    const sent = await ravi
      .post(`/api/departments/${research.id}/assistant-invite`)
      .send({ name: 'Sita Das', email: 'sita@example.com' })
      .expect(201);
    const token = sent.body.invite.link.split('/join/invite/')[1];
    await request(app).post(`/api/join/invite/${token}`).send({ name: 'Sita Das', password: 'sita-pass-12345' }).expect(201);
    const sita = await User.findOne({ email: 'sita@example.com' });
    assert.equal(sita.role, 'admin');
    assert.equal(String(sita.reportsTo), login.body.user.id);
    const sitaAgent = request.agent(app);
    await sitaAgent.post('/api/auth/login').send({ email: 'sita@example.com', password: 'sita-pass-12345' }).expect(200);
    await sitaAgent.get('/api/org').expect(403);
  });
});

describe('employee IDs', () => {
  beforeEach(async () => {
    await Department.init();
    await Department.deleteMany({});
  });

  it('gives each new person the next number in the CON series', async () => {
    await makeUser({ employeeId: 'CON-001' });
    await makeUser({ employeeId: 'CON-030' });
    const owner = await organiser();
    const dept = (await owner.post('/api/org/departments').send({ name: 'Research' }).expect(201)).body.department;

    const first = await owner.post('/api/org/people').send({ name: 'Asha Das', email: 'asha@example.com', department: dept.id }).expect(201);
    assert.equal(first.body.person.employeeId, 'CON-031');
    const second = await owner.post('/api/org/people').send({ name: 'Bina Roy', email: 'bina@example.com', department: dept.id }).expect(201);
    assert.equal(second.body.person.employeeId, 'CON-032');
  });
});

describe('the department on the dashboard', () => {
  it("shows colleagues' leave (who and when, not why) and only from the same department", async () => {
    const me = await signIn(await makeUser({ department: 'Sales' }));
    const colleague = await makeUser({ name: 'Colleague One', department: 'Sales' });
    const outsider = await makeUser({ name: 'Other Dept', department: 'HR' });
    await makeUser({ role: 'admin', department: 'Sales' });
    await makeUser({ role: 'admin', department: 'HR' });
    await apply(await signIn(colleague), { from: '2031-03-03', to: '2031-03-03', reason: 'Private reason' }).expect(201);
    await apply(await signIn(outsider), { from: '2031-03-04', to: '2031-03-04' }).expect(201);

    const { body } = await me.get('/api/me/summary?year=2031').expect(200);
    const team = [...body.upcoming, ...body.past].filter((entry) => entry.kind === 'team');
    assert.deepEqual(team.map((entry) => entry.title), ['Colleague One']);
    assert.equal(team[0].status, 'pending');
    assert.ok(!JSON.stringify(team).includes('Private reason'));
  });
});
