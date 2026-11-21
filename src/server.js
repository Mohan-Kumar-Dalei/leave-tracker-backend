import env from './config/env.js';
import { connectDb, disconnectDb } from './config/db.js';
import { createApp } from './app.js';
import { syncDepartments } from './services/departments.js';
import { syncPendingUsers } from './services/pendingUsers.js';
import { closeAllStreams } from './services/events.js';

async function start() {
  await connectDb();
  console.log(`MongoDB connected, database "${env.MONGO_DB_NAME}"`);
  // Everyone belongs to a department and each department knows who runs it,
  // so leave goes to the right person from the first request.
  await syncDepartments();
  // People who registered and are waiting for approval are in the users
  // collection too (pending, no access); this adds anyone from before.
  const waiting = await syncPendingUsers();
  if (waiting) console.log(`Added ${waiting} people waiting for approval to the users collection`);

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
