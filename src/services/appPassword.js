import nodemailer from 'nodemailer';
import env from '../config/env.js';
import AppPasswordLink from '../models/AppPasswordLink.js';
import { open, seal } from './secretBox.js';

// The second way to send from one's own Gmail: a 16 letter App Password made
// at myaccount.google.com/apppasswords (needs 2-Step Verification). Mail then
// goes over smtp.gmail.com from the person's address. Google cancels App
// Passwords when the account password changes, so a failed sign-in marks the
// link and the person is asked to add a new one.

// Google shows it as four groups of four letters.
export const normalisePassword = (value) => String(value ?? '').replace(/\s+/g, '').toLowerCase();
export const looksLikeAppPassword = (value) => /^[a-z]{16}$/.test(normalisePassword(value));

// Kept swappable so tests do not reach Google.
export const smtp = {
  create: (email, password) =>
    nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: email, pass: password },
      connectionTimeout: 15_000,
    }),
};

const isAuthError = (error) => error?.code === 'EAUTH' || error?.responseCode === 535 || error?.responseCode === 534;

export const appPasswordAvailable = () => Boolean(env.GMAIL_TOKEN_KEY);

// Signs in to Gmail once with the App Password before saving it.
export async function checkAppPassword(email, password) {
  const transport = smtp.create(email, normalisePassword(password));
  try {
    await transport.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, rejected: isAuthError(error), message: error.message };
  } finally {
    transport.close?.();
  }
}

export async function saveAppPassword(userId, email, password) {
  return AppPasswordLink.findOneAndUpdate(
    { user: userId },
    {
      email,
      password: seal(normalisePassword(password)),
      connectedAt: new Date(),
      $unset: { brokenAt: 1, brokenReason: 1 },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
}

export async function activeAppPasswordFor(userId) {
  if (!appPasswordAvailable() || !userId) return null;
  return AppPasswordLink.findOne({ user: userId, brokenAt: { $exists: false } }).select('+password');
}

export async function markAppPasswordBroken(link, reason) {
  await AppPasswordLink.updateOne({ _id: link._id }, { brokenAt: new Date(), brokenReason: reason });
}

export async function removeAppPassword(userId) {
  await AppPasswordLink.deleteOne({ user: userId });
}

// Sends one message from the person's Gmail. Throws with `rejected` set when
// Google refused the App Password.
export async function sendWithAppPassword(link, message) {
  const transport = smtp.create(link.email, open(link.password));
  try {
    await transport.sendMail(message);
    await AppPasswordLink.updateOne({ _id: link._id }, { lastSentAt: new Date() });
  } catch (error) {
    error.rejected = isAuthError(error);
    throw error;
  } finally {
    transport.close?.();
  }
}
