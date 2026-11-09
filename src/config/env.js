import 'dotenv/config';
import { z } from 'zod';

const bool = (fallback) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  MONGO_DB_NAME: z.string().min(1).default('leave_tracker'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET needs at least 32 characters'),
  ACCESS_TOKEN_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(7),

  CLIENT_ORIGINS: z.string().default('http://localhost:5173'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  APP_NAME: z.string().default('Leave Tracker'),
  COOKIE_SECURE: bool(false),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  TIMEZONE: z.string().default('Asia/Kolkata'),
  WEEKEND_DAYS: z.string().default('0'),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Leave Tracker <no-reply@example.com>'),
  // Leave mails go out from this mailbox under the person's own name, with
  // Reply-To set to that person. Empty means SMTP_USER.
  MAIL_ADDRESS: z.string().email().optional(),
  // Copied on leave applications by default, comma separated. Each entry is an
  // address or "Name <address>".
  LEAVE_MAIL_CC: z.string().default(''),
  LEAVE_MAIL_GREETING: z.string().default('Sir'),
  DEFAULT_DESIGNATION: z.string().default('Analyst'),

  // Mail signature
  COMPANY_NAME: z.string().default('Contify'),
  COMPANY_LOGO_URL: z.union([z.literal(''), z.string().url()]).default(''),
  COMPANY_TRIAL_URL: z.string().url().default('https://www.contify.com/'),
  COMPANY_DEMO_URL: z.string().url().default('https://www.contify.com/'),
  COMPANY_LINKEDIN_URL: z.string().url().default('https://www.linkedin.com/company/contify'),

  SEED_ADMIN_NAME: z.string().default('Admin'),
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD_HASH: z.string().optional(),
  SEED_EMPLOYEE_PASSWORD_HASH: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

function parseContacts(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(.*)<([^>]+)>$/);
      const email = (match ? match[2] : entry).trim().toLowerCase();
      const name = match ? match[1].trim().replace(/^"|"$/g, '') : '';
      return { name: name || email, email };
    });
}

const leaveMailContacts = parseContacts(env.LEAVE_MAIL_CC);

export default Object.freeze({
  ...env,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  clientOrigins: env.CLIENT_ORIGINS.split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean),
  weekendDays: env.WEEKEND_DAYS.split(',').map(Number),
  mailEnabled: Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS),
  mailAddress: env.MAIL_ADDRESS || env.SMTP_USER || 'leave-tracker@localhost',
  leaveMailContacts,
  leaveMailCc: leaveMailContacts.map((contact) => contact.email),
});
