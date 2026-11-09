import env from '../config/env.js';
import User from '../models/User.js';
import { badRequest } from '../utils/http.js';

// People a leave mail may be copied to: the usual leave list from the server
// settings and everyone with an active account. Keeping CC to this list stops
// the app's mailbox from being used to mail outsiders.
export async function mailContacts() {
  const users = await User.find({ isActive: true }).select('name email role').sort({ name: 1 });
  const contacts = [...env.leaveMailContacts];
  const seen = new Set(contacts.map((contact) => contact.email));
  for (const user of users) {
    if (seen.has(user.email)) continue;
    seen.add(user.email);
    contacts.push({ name: user.name, email: user.email });
  }
  return { contacts, users };
}

// Cleans the CC the employee chose. Their own address and the admins (who are
// already in To) are dropped, and anyone outside the contact list is refused.
export async function cleanCc(cc, { self, to = [] }) {
  const { contacts } = await mailContacts();
  const allowed = new Set(contacts.map((contact) => contact.email));
  const skip = new Set([self, ...to].map((address) => address.toLowerCase()));

  const result = [];
  for (const address of cc) {
    const email = address.toLowerCase();
    if (skip.has(email) || result.includes(email)) continue;
    if (!allowed.has(email)) throw badRequest(`${address} is not a colleague or on the usual leave list.`);
    result.push(email);
  }
  return result;
}
