import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_DB_NAME = 'leave_tracker_test_photo';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-1234';
process.env.MONGO_URI ??= 'mongodb://localhost:27017/';
process.env.CLIENT_ORIGINS = 'http://localhost:5173';
process.env.IMAGEKIT_PUBLIC_KEY = 'public_test';
process.env.IMAGEKIT_PRIVATE_KEY = 'private_test';
process.env.IMAGEKIT_URL_ENDPOINT = 'https://ik.imagekit.io/testco';

const { default: bcrypt } = await import('bcryptjs');
const { default: mongoose } = await import('mongoose');
const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { connectDb } = await import('../src/config/db.js');
const { default: User } = await import('../src/models/User.js');

const PASSWORD = 'correct-horse-42';
let app;
let passwordHash;
const realFetch = globalThis.fetch;

// ImageKit's answers per file id. Every call is recorded.
let files;
let calls;
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method ?? 'GET', auth: init.headers?.Authorization });
  const match = String(url).match(/files\/([^/]+)(\/details)?$/);
  const file = match && files[decodeURIComponent(match[1])];
  if (init.method === 'DELETE') return new Response(null, { status: 204 });
  if (!file) return new Response('{}', { status: 404 });
  return new Response(JSON.stringify(file), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const image = (fileId, overrides = {}) => ({
  fileId,
  fileType: 'image',
  filePath: `/leave-tracker/avatars/${fileId}.jpg`,
  size: 20_000,
  url: `https://ik.imagekit.io/testco/leave-tracker/avatars/${fileId}.jpg`,
  ...overrides,
});

async function signIn() {
  const suffix = new mongoose.Types.ObjectId().toString().slice(-8);
  const user = await User.create({ name: 'Photo Person', email: `p-${suffix}@example.com`, employeeId: `P-${suffix}`, passwordHash });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
  return { user, agent };
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
});

beforeEach(async () => {
  calls = [];
  files = {};
  await User.deleteMany({});
});

describe('profile photo', () => {
  it('hands out a short, single use upload signature and never the private key', async () => {
    const { agent, user } = await signIn();
    const { body } = await agent.get('/api/me/photo/upload-auth').expect(200);
    const expected = crypto.createHmac('sha1', 'private_test').update(body.token + body.expire).digest('hex');
    assert.equal(body.signature, expected);
    assert.equal(body.publicKey, 'public_test');
    assert.equal(body.folder, '/leave-tracker/avatars');
    assert.equal(body.fileName, `${user.id}.jpg`);
    assert.ok(body.expire - Date.now() / 1000 <= 600);
    assert.equal(JSON.stringify(body).includes('private_test'), false);
  });

  it('saves a checked picture, replaces the old one and removes it', async () => {
    const { agent } = await signIn();
    files.first1 = image('first1');
    files.second2 = image('second2');

    const first = await agent.post('/api/me/photo').send({ fileId: 'first1' }).expect(200);
    assert.equal(first.body.user.avatarUrl, files.first1.url);
    assert.equal('avatarFileId' in first.body.user, false);

    await agent.post('/api/me/photo').send({ fileId: 'second2' }).expect(200);
    assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/files/first1')));
    assert.ok(calls.every((call) => call.auth === `Basic ${Buffer.from('private_test:').toString('base64')}`));

    const removed = await agent.delete('/api/me/photo').expect(200);
    assert.equal(removed.body.user.avatarUrl, '');
    assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/files/second2')));
  });

  it('refuses files that are not our pictures', async () => {
    const { agent } = await signIn();
    files.pdf111 = image('pdf111', { fileType: 'non-image' });
    files.elsewhere = image('elsewhere', { filePath: '/other/elsewhere.jpg' });
    files.huge111 = image('huge111', { size: 5_000_000 });
    files.foreign1 = image('foreign1', { url: 'https://evil.example/x.jpg' });

    for (const fileId of ['pdf111', 'elsewhere', 'huge111', 'foreign1', 'missing1']) {
      await agent.post('/api/me/photo').send({ fileId }).expect(400);
    }
    await agent.post('/api/me/photo').send({ fileId: '../etc' }).expect(400);
    await agent.post('/api/me/photo').send({ url: 'https://evil.example/x.jpg' }).expect(400);
    const me = await agent.get('/api/auth/me').expect(200);
    assert.equal(me.body.user.avatarUrl, '');
  });
});
