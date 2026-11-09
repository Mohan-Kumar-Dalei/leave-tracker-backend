import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import morgan from 'morgan';
import env from './config/env.js';
import { requireAdmin, requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { apiLimiter, originCheck, sanitizeBody } from './middleware/security.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import googleRoutes from './routes/google.js';
import leaveRoutes from './routes/leaves.js';
import meRoutes from './routes/me.js';
import notificationRoutes from './routes/notifications.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Rate limits need the real client IP when running behind nginx.
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: env.COOKIE_SECURE,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || env.clientOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('CORS_NOT_ALLOWED'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      maxAge: 600,
    }),
  );

  // The live stream must not be buffered by gzip.
  app.use(compression({ filter: (req, res) => !req.path.endsWith('/stream') && compression.filter(req, res) }));

  if (!env.isTest) app.use(morgan(env.isProduction ? 'combined' : 'dev'));

  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  app.use(sanitizeBody);
  app.use(originCheck);

  app.get('/api/health', (_req, res) => {
    const database = mongoose.connection.readyState === 1 ? 'up' : 'down';
    res.status(database === 'up' ? 200 : 503).json({ status: 'ok', database });
  });

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use('/api', apiLimiter);
  app.use('/api/auth/google', googleRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/me', requireAuth, meRoutes);
  app.use('/api/leaves', requireAuth, leaveRoutes);
  app.use('/api/notifications', requireAuth, notificationRoutes);
  app.use('/api/admin', requireAuth, requireAdmin, adminRoutes);
  app.use('/api', requireAuth, catalogRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
