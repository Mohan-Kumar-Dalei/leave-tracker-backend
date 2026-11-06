import Notification from '../models/Notification.js';
import User from '../models/User.js';
import { pushToUser } from './events.js';

export async function notifyUsers(userIds, notification) {
  if (!userIds.length) return;
  const docs = await Notification.insertMany(
    userIds.map((recipient) => ({ recipient, ...notification })),
  );
  for (const doc of docs) {
    pushToUser(doc.recipient, 'notification', doc.toJSON());
  }
}

export function getActiveAdmins() {
  return User.find({ role: 'admin', isActive: true }).select('name email');
}

// Tells open dashboards to refetch, without a bell notification.
export function broadcastChange(userIds) {
  for (const userId of userIds) pushToUser(userId, 'leave-changed', {});
}
