import Notification from '../models/Notification.js';
import User from '../models/User.js';
import { pushToEveryone, pushToUser } from './events.js';

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

// Tells every open dashboard to refetch, without a bell notification. The team
// calendar is shared, so one person's leave changes what everyone sees. The
// event carries no leave data.
export function broadcastChange() {
  pushToEveryone('leave-changed', {});
}
