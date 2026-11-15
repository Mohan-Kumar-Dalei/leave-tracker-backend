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
