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

async function saveToOutbox({ to, subject, html }) {
  await fs.mkdir(OUTBOX_DIR, { recursive: true });
  const slug = subject.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50);
  const file = path.join(OUTBOX_DIR, `${Date.now()}-${slug}.html`);
  await fs.writeFile(file, `<!-- To: ${to} | Subject: ${subject} -->\n${html}`);
  console.log(`[mail] SMTP not configured, saved "${subject}" to ${path.relative('.', file)}`);
}

// Mail runs after the response and never fails the request. A leave must still
// be saved and visible on the dashboard if the mail provider is down.
export async function sendMail({ to, subject, html, text }) {
  if (env.isTest) return;
  try {
    if (!transporter) {
      await saveToOutbox({ to, subject, html });
      return;
    }
    await transporter.sendMail({ from: env.MAIL_FROM, to, subject, html, text });
  } catch (error) {
    console.error(`[mail] could not send "${subject}": ${error.message}`);
  }
}
