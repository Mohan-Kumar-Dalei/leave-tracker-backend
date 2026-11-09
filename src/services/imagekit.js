import crypto from 'node:crypto';
import env from '../config/env.js';

// Profile photos live on ImageKit. The browser uploads straight to ImageKit,
// because the hosting firewall blocks request bodies over 8 KB on the way to
// this API. The API only hands out a single use upload signature, and after the
// upload checks with ImageKit that the file really is an image in our folder
// before saving it on the person's profile. The private key never leaves the server.

const API = 'https://api.imagekit.io/v1/files';
export const AVATAR_FOLDER = '/leave-tracker/avatars';
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const SIGNATURE_SECONDS = 10 * 60;

const authHeader = () => `Basic ${Buffer.from(`${env.IMAGEKIT_PRIVATE_KEY}:`).toString('base64')}`;

// ImageKit's client upload signature: HMAC-SHA1 of token + expire.
export function uploadAuth(userId) {
  const token = crypto.randomUUID();
  const expire = Math.floor(Date.now() / 1000) + SIGNATURE_SECONDS;
  const signature = crypto.createHmac('sha1', env.IMAGEKIT_PRIVATE_KEY).update(token + expire).digest('hex');
  return {
    publicKey: env.IMAGEKIT_PUBLIC_KEY,
    token,
    expire,
    signature,
    folder: AVATAR_FOLDER,
    fileName: `${userId}.jpg`,
  };
}

export async function fileDetails(fileId) {
  const res = await fetch(`${API}/${encodeURIComponent(fileId)}/details`, { headers: { Authorization: authHeader() } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ImageKit answered ${res.status}`);
  return res.json();
}

export async function deleteFile(fileId) {
  try {
    await fetch(`${API}/${encodeURIComponent(fileId)}`, { method: 'DELETE', headers: { Authorization: authHeader() } });
  } catch (error) {
    console.error(`[imagekit] could not delete ${fileId}: ${error.message}`);
  }
}

// Only a picture we asked for: in the avatars folder, an image, not too big,
// and served from our own ImageKit address.
export function isUsableAvatar(details) {
  if (!details) return false;
  const endpoint = env.IMAGEKIT_URL_ENDPOINT.replace(/\/$/, '');
  return (
    details.fileType === 'image' &&
    typeof details.filePath === 'string' &&
    details.filePath.startsWith(`${AVATAR_FOLDER}/`) &&
    Number(details.size) > 0 &&
    Number(details.size) <= MAX_AVATAR_BYTES &&
    typeof details.url === 'string' &&
    details.url.startsWith(`${endpoint}/`)
  );
}
