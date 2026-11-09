import env from '../config/env.js';
import GmailLink from '../models/GmailLink.js';
import { open, seal } from './secretBox.js';

// "Connect Gmail": a person allows the app to send mail from their own Gmail
// through the Gmail API. The mail then really comes from their address and
// shows in their Sent folder. Only the send permission is asked for; the app
// cannot read anyone's mail.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const SCOPES = ['openid', 'email', SEND_SCOPE];

export class GmailError extends Error {
  constructor(message, { broken = false } = {}) {
    super(message);
    this.broken = broken;
  }
}

export function authUrl({ state, loginHint }) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.googleRedirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    // Asks every time, so Google always returns a refresh token.
    prompt: 'consent',
    state,
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      ...body,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const broken = data.error === 'invalid_grant';
    throw new GmailError(`Google refused the token request (${data.error ?? res.status}).`, { broken });
  }
  return data;
}

// The ID token comes straight from Google's token endpoint over TLS, so its
// claims can be read without checking the signature (OpenID Connect 3.1.3.7).
function idTokenClaims(idToken) {
  const payload = String(idToken ?? '').split('.')[1];
  if (!payload) return {};
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

// Turns the code from Google's redirect into the person's address, the
// permissions they gave, and a refresh token.
export async function exchangeCode(code) {
  const data = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: env.googleRedirectUri });
  const claims = idTokenClaims(data.id_token);
  return {
    email: String(claims.email ?? '').toLowerCase(),
    emailVerified: claims.email_verified === true,
    scope: data.scope ?? '',
    refreshToken: data.refresh_token,
  };
}

export async function saveLink(userId, { email, scope, refreshToken }) {
  return GmailLink.findOneAndUpdate(
    { user: userId },
    {
      email,
      scope,
      refreshToken: seal(refreshToken),
      connectedAt: new Date(),
      $unset: { brokenAt: 1, brokenReason: 1 },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
}

// Short lived access tokens, kept in memory until a minute before they expire.
const accessTokens = new Map();

async function accessTokenFor(link) {
  const cached = accessTokens.get(String(link.user));
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const data = await tokenRequest({ refresh_token: open(link.refreshToken), grant_type: 'refresh_token' });
  accessTokens.set(String(link.user), { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

// The working link for a person, or null when they have not connected Gmail,
// it stopped working, or the feature is off.
export async function activeLinkFor(userId) {
  if (!env.gmailEnabled || !userId) return null;
  const link = await GmailLink.findOne({ user: userId, brokenAt: { $exists: false } }).select('+refreshToken');
  return link ?? null;
}

export async function markBroken(link, reason) {
  accessTokens.delete(String(link.user));
  await GmailLink.updateOne({ _id: link._id }, { brokenAt: new Date(), brokenReason: reason });
}

// Sends a complete MIME message from the person's own Gmail.
export async function sendRaw(link, raw) {
  const token = await accessTokenFor(link);
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const broken = res.status === 401 || res.status === 403;
    throw new GmailError(`Gmail did not send the mail (${data.error?.message ?? res.status}).`, { broken });
  }
  await GmailLink.updateOne({ _id: link._id }, { lastSentAt: new Date() });
  return data;
}

// Takes the permission back at Google and forgets the token.
export async function disconnect(userId) {
  const link = await GmailLink.findOne({ user: userId }).select('+refreshToken');
  if (!link) return;
  accessTokens.delete(String(userId));
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: open(link.refreshToken) }),
    });
  } catch {
    // The token is deleted here either way; Google drops unused ones in time.
  }
  await GmailLink.deleteOne({ _id: link._id });
}
