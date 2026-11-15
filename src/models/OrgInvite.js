import mongoose from 'mongoose';

// The owner's invitation to a department's manager or assistant manager. The
// mail carries a one-time link; only its hash is kept here.
const orgInviteSchema = new mongoose.Schema(
  {
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    role: { type: String, enum: ['manager', 'assistant'], required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 160 },
    designation: { type: String, trim: true, maxlength: 80, default: '' },
    tokenHash: { type: String, required: true, unique: true, select: false },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

orgInviteSchema.set('toJSON', {
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.tokenHash;
    return ret;
  },
});

export default mongoose.models.OrgInvite ?? mongoose.model('OrgInvite', orgInviteSchema);
