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
  WEEKEND_DAYS: z.string().default('0,6'),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Leave Tracker <no-reply@example.com>'),

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

export default Object.freeze({
  ...env,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  clientOrigins: env.CLIENT_ORIGINS.split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean),
  weekendDays: env.WEEKEND_DAYS.split(',').map(Number),
  mailEnabled: Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS),
});
