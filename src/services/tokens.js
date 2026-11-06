import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import RefreshToken from '../models/RefreshToken.js';
import User from '../models/User.js';
import { unauthorized } from '../utils/http.js';

export const ACCESS_COOKIE = 'lt_access';
export const REFRESH_COOKIE = 'lt_refresh';

const ISSUER = 'leave-tracker';
const REFRESH_PATH = '/api/auth';
// Two tabs can refresh at the same moment. The slower one is not a stolen token.
const REUSE_GRACE_MS = 20 * 1000;

const cookieBase = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'strict',
};

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const randomToken = () => crypto.randomBytes(48).toString('base64url');

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, v: user.tokenVersion ?? 0 }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: `${env.ACCESS_TOKEN_MINUTES}m`,
    issuer: ISSUER,
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER });
}

function setAccessCookie(res, user) {
  res.cookie(ACCESS_COOKIE, signAccessToken(user), {
    ...cookieBase,
    path: '/api',
    maxAge: env.ACCESS_TOKEN_MINUTES * 60 * 1000,
  });
}

async function setRefreshCookie(res, user, family) {
  const token = randomToken();
  const maxAge = env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000;
  await RefreshToken.create({
    user: user.id,
    tokenHash: sha256(token),
    family,
    expiresAt: new Date(Date.now() + maxAge),
  });
  res.cookie(REFRESH_COOKIE, token, { ...cookieBase, path: REFRESH_PATH, maxAge });
}

export async function startSession(res, user) {
  setAccessCookie(res, user);
  await setRefreshCookie(res, user, crypto.randomUUID());
}

export async function rotateSession(req, res) {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) throw unauthorized();

  const stored = await RefreshToken.findOne({ tokenHash: sha256(token) });
  if (!stored) throw unauthorized();

  const user = await User.findById(stored.user).select('+tokenVersion');
  if (!user || !user.isActive) throw unauthorized();

  if (stored.revokedAt) {
    if (Date.now() - stored.revokedAt.getTime() < REUSE_GRACE_MS) {
      setAccessCookie(res, user);
      return user;
    }
    // An old token came back after rotation, so end that whole login.
    await RefreshToken.updateMany({ family: stored.family }, { revokedAt: new Date() });
    throw unauthorized('Your session has expired.');
  }

  stored.revokedAt = new Date();
  await stored.save();
  setAccessCookie(res, user);
  await setRefreshCookie(res, user, stored.family);
  return user;
}

export async function endSession(req, res) {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) {
    await RefreshToken.updateOne({ tokenHash: sha256(token) }, { revokedAt: new Date() });
  }
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase, path: '/api' });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase, path: REFRESH_PATH });
}

export async function revokeAllSessions(userId) {
  await RefreshToken.updateMany({ user: userId, revokedAt: null }, { revokedAt: new Date() });
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
}
