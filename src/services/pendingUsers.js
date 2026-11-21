import Department from '../models/Department.js';
import JoinRequest from '../models/JoinRequest.js';
import User from '../models/User.js';
import { nextEmployeeId } from './employeeIds.js';

// Everyone who registers is in the users collection from the start, with
// their email, so the database shows every person who signed up:
//   pending   waiting for approval (a join link, or a manager registering);
//             no password and access off, so they cannot sign in yet
//   approved  approved: the next CON employee ID, their password, access on
//   rejected  turned down: kept, access off
// While waiting they carry a request ID (REQ-...) instead of an employee ID,
// so the CON series still has no gaps from requests that were turned down.
// The app's lists leave pending and rejected people out (see hidden.js and
// memberFilter).

const requestId = (request) => `REQ-${String(request._id).slice(-8).toUpperCase()}`;

// Makes (or refreshes) the pending user for a join request and links them.
export async function linkPendingUser(request) {
  const email = request.email.toLowerCase();
  const fields = {
    name: request.name,
    email,
    phone: request.phone || '',
    designation: request.designation || (request.kind === 'manager' ? 'Manager' : ''),
    department: request.kind === 'manager' ? request.departmentName : '',
    role: 'employee',
    isActive: false,
    approval: 'pending',
  };
  let user = await User.findOne({ email });
  if (user && user.approval !== 'pending' && user.approval !== 'rejected') return null; // a real account already
  if (user) {
    Object.assign(user, fields);
    if (!/^REQ-/.test(user.employeeId)) user.employeeId = requestId(request);
    await user.save();
  } else {
    user = await User.create({ ...fields, employeeId: requestId(request) });
  }
  // A member's department is set from the request's department id.
  if (request.kind !== 'manager' && request.department && !user.department) {
    const department = await Department.findById(request.department).select('name');
    if (department) await User.updateOne({ _id: user._id }, { department: department.name });
  }
  if (String(request.user ?? '') !== user.id) {
    request.user = user._id;
    await JoinRequest.updateOne({ _id: request._id }, { user: user._id });
  }
  return user;
}

// On approval: the waiting user becomes a real account, with the next CON
// employee ID. Requests from before this have no waiting user; one is made.
export async function approvePendingUser(request, fields) {
  let user = request.user ? await User.findById(request.user) : null;
  if (!user) user = await User.findOne({ email: request.email.toLowerCase(), approval: { $in: ['pending', 'rejected'] } });
  if (!user) user = await linkPendingUser(request);
  if (!user) throw new Error('That email already has an account.');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    Object.assign(user, fields, { employeeId: await nextEmployeeId(), isActive: true, approval: 'approved' });
    try {
      await user.save();
      return user;
    } catch (error) {
      const clash = error?.code === 11000 && Object.keys(error.keyPattern ?? {}).includes('employeeId');
      if (!clash || attempt === 4) throw error;
    }
  }
  throw new Error('Could not give an employee ID.');
}

// On rejection the user stays in the collection, turned down and with no access.
export async function rejectPendingUser(request) {
  const filter = request.user ? { _id: request.user } : { email: request.email.toLowerCase(), approval: 'pending' };
  await User.updateOne({ ...filter, approval: 'pending' }, { approval: 'rejected', isActive: false });
}

// At start-up: anyone already waiting before this existed gets their pending
// user, so the collection shows them too. Safe to run every time.
export async function syncPendingUsers() {
  // Accounts from before this field existed are approved; saying so keeps
  // the collection consistent when read in the database.
  await User.updateMany({ approval: { $exists: false } }, { $set: { approval: 'approved' } });
  const waiting = await JoinRequest.find({ status: 'pending' });
  let added = 0;
  for (const request of waiting) {
    const before = request.user;
    const user = await linkPendingUser(request);
    if (user && !before) added += 1;
  }
  return added;
}
