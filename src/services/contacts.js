import env from '../config/env.js';
import User from '../models/User.js';

// Names for addresses: the usual leave list from the server settings and
// everyone with an active account.
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

// Cleans a list of typed addresses: lower case, no repeats, and without the
// addresses in skip (the sender, or people already in To).
export function cleanAddresses(list, skip = []) {
  const drop = new Set(skip.map((address) => address.toLowerCase()));
  const result = [];
  for (const address of list) {
    const email = address.trim().toLowerCase();
    if (!email || drop.has(email) || result.includes(email)) continue;
    result.push(email);
  }
  return result;
}
