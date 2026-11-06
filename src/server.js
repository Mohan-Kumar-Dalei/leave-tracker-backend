import env from './config/env.js';
import { connectDb, disconnectDb } from './config/db.js';
import { createApp } from './app.js';
import { closeAllStreams } from './services/events.js';

async function start() {
  await connectDb();
  console.log(`MongoDB connected, database "${env.MONGO_DB_NAME}"`);

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT}`);
    if (!env.mailEnabled) {
      console.log('SMTP is not configured, mails will be saved to .mail-outbox/');
    }
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    closeAllStreams();
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

start().catch((error) => {
  console.error('Could not start the server:', error.message);
  process.exit(1);
});
