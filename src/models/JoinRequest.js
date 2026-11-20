import mongoose from 'mongoose';

// A request to join, waiting for approval:
//   member   someone who opened a department's join link; the department's
//            assistant manager (or manager) approves them.
//   manager  a manager who registered on their own with a new department;
//            HR approves them, which creates the department.
// They get an account only when approved. The password they chose is kept as
// a bcrypt hash until then.
const joinRequestSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['member', 'manager'], default: 'member', index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', index: true },
    // For a manager's request: the department they want to set up.
    departmentName: { type: String, trim: true, maxlength: 60, default: '' },
    location: { type: String, trim: true, maxlength: 60, default: '' },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 160 },
    // Given on approval (the next CON number); older requests may carry one.
    employeeId: { type: String, trim: true, uppercase: true, maxlength: 20, default: '' },
    phone: { type: String, trim: true, maxlength: 20, default: '' },
    designation: { type: String, trim: true, maxlength: 80, default: '' },
    // Cleared once the request is decided: the account has it, or nobody needs it.
    passwordHash: { type: String, select: false },
    // Their Gmail App Password, sealed, until approval moves it to their account.
    appPassword: { type: String, select: false },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

joinRequestSchema.set('toJSON', {
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.passwordHash;
    delete ret.appPassword;
    return ret;
  },
});

export default mongoose.models.JoinRequest ?? mongoose.model('JoinRequest', joinRequestSchema);
