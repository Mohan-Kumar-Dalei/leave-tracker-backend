import mongoose from 'mongoose';

// Someone who opened a department's join link and asked to join. They get an
// account only when the department's manager or assistant manager approves.
// The password they chose is kept as a bcrypt hash until then.
const joinRequestSchema = new mongoose.Schema(
  {
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 160 },
    employeeId: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    phone: { type: String, trim: true, maxlength: 20, default: '' },
    designation: { type: String, trim: true, maxlength: 80, default: '' },
    // Cleared once the request is decided: the account has it, or nobody needs it.
    passwordHash: { type: String, select: false },
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
    return ret;
  },
});

export default mongoose.models.JoinRequest ?? mongoose.model('JoinRequest', joinRequestSchema);
