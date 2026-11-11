import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import env from '../config/env.js';
import { activeAppPasswordFor, markAppPasswordBroken, sendWithAppPassword } from './appPassword.js';
import User from '../models/User.js';
import { notifyUsers } from './notify.js';

const OUTBOX_DIR = path.resolve('.mail-outbox');

const transporter = env.mailEnabled
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      pool: true,
      maxConnections: 3,
    })
  : null;

// A Message-ID we choose ourselves, so it can be saved before the mail goes out
// and used later to thread the reply under it.
export function newMessageId() {
  const domain = env.mailAddress.split('@')[1] || 'localhost';
  return `<leave.${crypto.randomUUID()}@${domain}>`;
}

const one = (entry) => (typeof entry === 'object' && entry ? `${entry.name} <${entry.address}>` : entry);
const list = (value) => (Array.isArray(value) ? value.map(one).join(', ') : one(value) || '');
const headerSafe = (value) => list(value).replace(/[\r\n]+/g, ' ').replace(/--/g, '- -');

async function saveToOutbox(message) {
  await fs.mkdir(OUTBOX_DIR, { recursive: true });
  const slug = message.subject.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50);
  const file = path.join(OUTBOX_DIR, `${Date.now()}-${slug}.html`);
  const from = typeof message.from === 'string' ? message.from : `${message.from.name} <${message.from.address}>`;
  const headers = [
    `From: ${from}`,
    `Reply-To: ${list(message.replyTo)}`,
    `To: ${list(message.to)}`,
    `Cc: ${list(message.cc)}`,
    `Subject: ${message.subject}`,
    `Message-ID: ${message.messageId || ''}`,
    `In-Reply-To: ${message.inReplyTo || ''}`,
  ]
    .map(headerSafe)
    .join('\n');
  await fs.writeFile(file, `<!--\n${headers}\n-->\n${message.html}`);
  console.log(`[mail] SMTP not configured, saved "${message.subject}" to ${path.relative('.', file)}`);
}

// Tries the sender's Gmail App Password. Returns true when Gmail took the mail.
async function sendWithOwnAppPassword(sender, message) {
  const link = await activeAppPasswordFor(sender._id ?? sender.id);
  if (!link) return false;

  try {
    await sendWithAppPassword(link, { ...message, from: { name: sender.name, address: link.email }, replyTo: undefined });
    return true;
  } catch (error) {
    console.error(`[mail] App Password of ${link.email} could not send "${message.subject}": ${error.message}`);
    if (error.rejected) {
      await markAppPasswordBroken(link, error.message);
      await notifyUsers([link.user], {
        kind: 'gmail',
        title: 'Add your App Password again',
        body: 'Google stopped accepting your App Password, which happens after a password change. Make a new one and add it in your profile.',
        link: '/profile',
      });
    }
    return false;
  }
}

// Mail runs after the response and never fails the request. A leave must still
// be saved and visible on the dashboard if the mail provider is down.
//
// `sender` is the person the mail speaks for. When they saved a Gmail App
// Password, it goes from their own address. Otherwise it leaves from the
// app's mailbox under their name, and replies go to them.
export async function sendMail(options) {
  if (env.isTest) return true;
  return deliverMail(options);
}

// Puts names on addresses, so inboxes show "Rajesh Swain <rajesh@...>" and not
// only the address. Names come from the usual CC list in the server settings
// and from people's accounts. An address nobody knows stays as it is.
export async function withNames(addresses = []) {
  const list = [].concat(addresses ?? []).filter(Boolean);
  if (list.length === 0) return list;

  const names = new Map(env.leaveMailContacts.filter((c) => c.name !== c.email).map((c) => [c.email, c.name]));
  const users = await User.find({ email: { $in: list.map((a) => String(a).toLowerCase()) } }).select('name email');
  for (const user of users) names.set(user.email, user.name);

  return list.map((address) => {
    const name = names.get(String(address).toLowerCase());
    return name ? { name, address } : address;
  });
}

export async function deliverMail({ to, cc, sender, subject, html, text, messageId, inReplyTo }) {
  const message = {
    from: sender ? { name: sender.name, address: env.mailAddress } : env.MAIL_FROM,
    replyTo: sender?.email,
    to: await withNames(to),
    cc: cc?.length ? await withNames(cc) : undefined,
    subject,
    html,
    text,
    messageId,
    inReplyTo,
    references: inReplyTo ? [inReplyTo] : undefined,
  };

  if (sender && (await sendWithOwnAppPassword(sender, message))) return true;

  try {
    if (!transporter) {
      await saveToOutbox(message);
      return true;
    }
    await transporter.sendMail(message);
    return true;
  } catch (error) {
    console.error(`[mail] could not send "${subject}": ${error.message}`);
    return false;
  }
}
