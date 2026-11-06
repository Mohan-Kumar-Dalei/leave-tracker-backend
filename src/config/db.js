import mongoose from 'mongoose';
import env from './env.js';

mongoose.set('strictQuery', true);

export async function connectDb() {
  await mongoose.connect(env.MONGO_URI, {
    dbName: env.MONGO_DB_NAME,
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 10,
    autoIndex: true,
  });
  return mongoose.connection;
}

export function disconnectDb() {
  return mongoose.disconnect();
}
