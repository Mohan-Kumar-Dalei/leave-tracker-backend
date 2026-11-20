import mongoose from 'mongoose';

// A department of the organisation. People belong to one by the department
// name on their user record.
//   managerName  the department's manager (like an Associate Director), shown
//                on the department; they need no account.
//   admins       holds the Assistant Manager, who gets the owner's invitation,
//                runs the department, invites the team and approves them, and
//                will run its leave once the leave tracker joins the organisation.
//   manager      an account for the manager, if they ever have one.
//   joinCode     the code in the department's join link.
const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    location: { type: String, trim: true, maxlength: 60, default: '' },
    managerName: { type: String, trim: true, maxlength: 80, default: '' },
    manager: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    admins: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    joinCode: { type: String, select: false },
  },
  { timestamps: true },
);

// One department per name, whatever the letter case.
departmentSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
departmentSchema.index({ joinCode: 1 }, { unique: true, sparse: true });

// Saves each person's position on their user record (manager, assistant
// manager, employee, or HR for the owner), so the users collection shows who
// is who. Runs after any department is saved, and from syncDepartments.
export async function refreshPositions() {
  const User = mongoose.model('User');
  const departments = await mongoose.model('Department').find({}).select('manager admins');
  const managers = departments.map((department) => department.manager).filter(Boolean);
  const assistants = departments.map((department) => department.admins?.[0]).filter(Boolean);
  await User.updateMany({ role: 'owner' }, { $set: { position: 'hr' } });
  await User.updateMany({ _id: { $in: managers } }, { $set: { position: 'manager' } });
  await User.updateMany({ _id: { $in: assistants, $nin: managers } }, { $set: { position: 'assistantmanager' } });
  await User.updateMany(
    { role: { $ne: 'owner' }, _id: { $nin: [...managers, ...assistants] } },
    { $set: { position: 'employee' } },
  );
}

departmentSchema.post('save', async () => {
  await refreshPositions();
});

departmentSchema.set('toJSON', {
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.joinCode;
    return ret;
  },
});

export default mongoose.models.Department ?? mongoose.model('Department', departmentSchema);
