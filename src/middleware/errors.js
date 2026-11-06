import env from '../config/env.js';
import { ApiError } from '../utils/http.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ message: 'Route not found.' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ message: err.message, code: err.code, field: err.field });
  }

  if (err?.code === 11000) {
    return res.status(409).json({ message: 'That record already exists.' });
  }

  if (err?.name === 'CastError' || err?.name === 'ValidationError') {
    return res.status(400).json({ message: 'That request is not valid.' });
  }

  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'That request is not valid JSON.' });
  }

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ message: 'That request is too large.' });
  }

  if (err?.message === 'CORS_NOT_ALLOWED') {
    return res.status(403).json({ message: 'This origin is not allowed.' });
  }

  if (!env.isTest) console.error(`[${req.method} ${req.originalUrl}]`, err);

  return res.status(500).json({
    message: 'Something went wrong on our side. Please try again.',
    ...(env.isProduction ? {} : { detail: err?.message }),
  });
}
