import crypto from 'node:crypto';
import { Router } from 'express';
import env from '../config/env.js';
import OAuthState from '../models/OAuthState.js';
import User from '../models/User.js';
import { exchangeCode, saveLink, SEND_SCOPE } from '../services/gmail.js';
import { sha256 } from '../services/tokens.js';

// Google sends people back here after "Connect Gmail". The sign-in cookies are
// SameSite=Strict and do not come with this cross-site redirect, so the
// person is found from the state Google returns. That state must also match
// a short lived Lax cookie set in the same browser when the attempt started,
// so a link made in one browser cannot attach a Gmail in another.

export const STATE_COOKIE = 'lt_gstate';
export const STATE_COOKIE_PATH = '/api/auth/google';

const router = Router();

const back = (res, result) => res.redirect(303, `${env.APP_URL.replace(/\/$/, '')}/profile?gmail=${result}`);

const sameString = (a, b) => {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const cookieState = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: STATE_COOKIE_PATH, httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax' });

  if (!env.gmailEnabled) return back(res, 'off');
  if (typeof state !== 'string' || !state || !sameString(state, cookieState)) return back(res, 'expired');

  // Single use: the record is gone after this, whatever happens next.
  const attempt = await OAuthState.findOneAndDelete({ stateHash: sha256(state), expiresAt: { $gt: new Date() } });
  if (!attempt) return back(res, 'expired');
  if (error || typeof code !== 'string') return back(res, 'cancelled');

  try {
    const user = await User.findById(attempt.user);
    if (!user?.isActive) return back(res, 'failed');

    const granted = await exchangeCode(code);
    if (!granted.emailVerified || granted.email !== user.email) return back(res, 'wrong-account');
    if (!granted.scope.split(' ').includes(SEND_SCOPE)) return back(res, 'no-permission');
    if (!granted.refreshToken) return back(res, 'failed');

    await saveLink(user._id, granted);
    return back(res, 'connected');
  } catch (issue) {
    console.error(`[gmail] connect failed: ${issue.message}`);
    return back(res, 'failed');
  }
});

export default router;
