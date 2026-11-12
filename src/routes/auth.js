import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter, passwordMailLimiter, refreshLimiter } from '../middleware/security.js';
import { validate } from '../middleware/validate.js';
import User from '../models/User.js';
import { sendMail } from '../services/mail.js';
import { resetMail } from '../services/mailTemplates.js';
import {
  endSession,
  randomToken,
  revokeAllSessions,
  rotateSession,
  sha256,
  startSession,
} from '../services/tokens.js';
import { badRequest, unauthorized } from '../utils/http.js';
import { email, password } from '../utils/schemas.js';

const router = Router();

const BCRYPT_COST = 12;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const RESET_TTL_MS = 60 * 60 * 1000;

// Compared when the email is unknown, so a wrong email takes as long as a wrong
// password and the login form cannot be used to discover accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

const INVALID_LOGIN = 'That email and password do not match.';

router.post(
  '/login',
  authLimiter,
  validate({ body: z.strictObject({ email, password: z.string().min(1).max(200) }) }),
  async (req, res) => {
    const { email: address, password: attempt } = req.valid.body;

    const user = await User.findOne({ email: address }).select(
      '+passwordHash +tokenVersion +failedLogins +lockedUntil',
    );

    const hash = user?.passwordHash ?? DUMMY_HASH;
    const matches = await bcrypt.compare(attempt, hash);

    if (!user || !user.isActive || !user.passwordHash) throw unauthorized(INVALID_LOGIN);

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw unauthorized(`Too many attempts. Try again in ${LOCK_MINUTES} minutes or reset your password.`);
    }

    if (!matches) {
      user.failedLogins = (user.failedLogins ?? 0) + 1;
      if (user.failedLogins >= MAX_FAILED_LOGINS) {
        user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
        user.failedLogins = 0;
      }
      await user.save();
      throw unauthorized(INVALID_LOGIN);
    }

    user.failedLogins = 0;
    user.lockedUntil = undefined;
    await user.save();

    await startSession(res, user);
    res.json({ user });
  },
);

router.post('/refresh', refreshLimiter, async (req, res) => {
  const user = await rotateSession(req, res);
  res.json({ user });
});

router.post('/logout', async (req, res) => {
  await endSession(req, res);
  res.status(204).end();
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post(
  '/forgot-password',
  passwordMailLimiter,
  validate({ body: z.strictObject({ email }) }),
  async (req, res) => {
    const user = await User.findOne({ email: req.valid.body.email, isActive: true });

    if (user) {
      const token = randomToken();
      await User.updateOne(
        { _id: user._id },
        { resetTokenHash: sha256(token), resetTokenExpires: new Date(Date.now() + RESET_TTL_MS) },
      );
      // Sent as the person themselves: with their saved Gmail App Password it
      // goes from their own Gmail to their own inbox. The server has no
      // mailbox of its own, so without one it waits in the outbox.
      sendMail({ to: user.email, sender: user, ...resetMail({ user, token }) });
    }

    // Same answer either way, so this cannot reveal who has an account.
    res.json({ message: 'If that email has an account, a reset link is on its way.' });
  },
);

router.post(
  '/reset-password',
  authLimiter,
  validate({ body: z.strictObject({ token: z.string().min(20).max(200), password }) }),
  async (req, res) => {
    const { token, password: nextPassword } = req.valid.body;

    const user = await User.findOne({
      resetTokenHash: sha256(token),
      resetTokenExpires: { $gt: new Date() },
      isActive: true,
    });
    if (!user) throw badRequest('This link has expired. Please ask for a new one.');

    await User.updateOne(
      { _id: user._id },
      {
        passwordHash: await bcrypt.hash(nextPassword, BCRYPT_COST),
        failedLogins: 0,
        $unset: { resetTokenHash: 1, resetTokenExpires: 1, lockedUntil: 1 },
      },
    );
    await revokeAllSessions(user._id);

    res.json({ message: 'Password saved. You can sign in now.' });
  },
);

router.post(
  '/change-password',
  requireAuth,
  validate({ body: z.strictObject({ currentPassword: z.string().min(1).max(200), newPassword: password }) }),
  async (req, res) => {
    const { currentPassword, newPassword } = req.valid.body;
    const user = await User.findById(req.user.id).select('+passwordHash');

    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw badRequest('Your current password is not correct.');
    }

    await User.updateOne({ _id: user._id }, { passwordHash: await bcrypt.hash(newPassword, BCRYPT_COST) });
    await revokeAllSessions(user._id);

    const fresh = await User.findById(user._id).select('+tokenVersion');
    await startSession(res, fresh);
    res.json({ message: 'Password changed. Other devices have been signed out.' });
  },
);

export default router;
