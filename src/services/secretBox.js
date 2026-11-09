import crypto from 'node:crypto';
import env from '../config/env.js';

// AES-256-GCM for secrets kept in the database, such as Google refresh tokens.
// The key lives only in the server's .env, so a copy of the database alone
// cannot be used to send mail as anyone.

const key = () => Buffer.from(env.GMAIL_TOKEN_KEY ?? '', 'hex');

export function seal(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function open(sealed) {
  const [version, iv, tag, data] = String(sealed).split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unknown sealed format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
