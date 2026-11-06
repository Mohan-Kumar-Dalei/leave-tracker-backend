import rateLimit from 'express-rate-limit';
import env from '../config/env.js';
import { forbidden } from '../utils/http.js';

const limiter = (options) =>
  rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.isTest,
    message: { message: 'Too many requests. Please wait a little and try again.' },
    ...options,
  });

export const apiLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 600 });

// Failed sign-ins and reset mails are the actions worth slowing down.
export const authLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
});

// Every page load by a signed out visitor fails one refresh, which must never
// use up the budget that protects the sign in form.
export const refreshLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 200 });

export const passwordMailLimiter = limiter({ windowMs: 60 * 60 * 1000, limit: 5 });

export const applyLimiter = limiter({ windowMs: 60 * 60 * 1000, limit: 60 });

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Cookies are SameSite=Strict. This is the second layer: a browser request that
// changes data must come from a site on the allowlist.
export function originCheck(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !env.clientOrigins.includes(origin)) {
    return next(forbidden('This origin is not allowed.'));
  }
  return next();
}

function stripDangerousKeys(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || key.includes('.') || key === '__proto__' || key === 'constructor') {
      delete value[key];
    } else {
      stripDangerousKeys(value[key], depth + 1);
    }
  }
}

// Removes MongoDB operators from JSON bodies as a safety net behind validation.
export function sanitizeBody(req, _res, next) {
  stripDangerousKeys(req.body);
  next();
}
