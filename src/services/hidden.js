import User from '../models/User.js';

// Hidden accounts are for the people who run the app to test with. They can
// sign in and use everything, but nobody else sees them: they are left out of
// the employee list, the team calendar, the team's upcoming and past leave,
// the admin overview and requests, the CSV export and the To/CC names.

export const notHidden = { hidden: { $ne: true } };

export async function hiddenUserIds() {
  const users = await User.find({ hidden: true }).select('_id');
  return users.map((user) => user._id);
}

// A condition for Leave and ImportedUsage queries: not by a hidden person.
export async function visibleLeaveOwners() {
  return { $nin: await hiddenUserIds() };
}
