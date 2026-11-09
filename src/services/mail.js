import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import env from '../config/env.js';

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

const list = (value) => (Array.isArray(value) ? value.join(', ') : value || '');
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

// Mail runs after the response and never fails the request. A leave must still
// be saved and visible on the dashboard if the mail provider is down.
//
// `sender` is { name, email } of the person the mail speaks for. The mail leaves
// from our own mailbox under that name, and replies go to the person.
export async function sendMail({ to, cc, sender, subject, html, text, messageId, inReplyTo }) {
  if (env.isTest) return true;

  const message = {
    from: sender ? { name: sender.name, address: env.mailAddress } : env.MAIL_FROM,
    replyTo: sender?.email,
    to,
    cc: cc?.length ? cc : undefined,
    subject,
    html,
    text,
    messageId,
    inReplyTo,
    references: inReplyTo ? [inReplyTo] : undefined,
  };

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
