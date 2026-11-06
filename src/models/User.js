import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 160 },
    employeeId: { type: String, required: true, unique: true, trim: true, uppercase: true, maxlength: 20 },
    role: { type: String, enum: ['employee', 'admin'], default: 'employee', index: true },
    department: { type: String, trim: true, maxlength: 60, default: '' },
    designation: { type: String, trim: true, maxlength: 80, default: '' },
    joinedOn: { type: Date },
    isActive: { type: Boolean, default: true, index: true },

    passwordHash: { type: String, select: false },
    tokenVersion: { type: Number, default: 0, select: false },
    failedLogins: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, select: false },
    resetTokenHash: { type: String, select: false, index: true, sparse: true },
    resetTokenExpires: { type: Date, select: false },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        delete ret.tokenVersion;
        delete ret.failedLogins;
        delete ret.lockedUntil;
        delete ret.resetTokenHash;
        delete ret.resetTokenExpires;
        return ret;
      },
    },
  },
);

export default mongoose.model('User', userSchema);
