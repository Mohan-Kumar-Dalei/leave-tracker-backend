import mongoose from 'mongoose';

const leaveTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 10 },
    description: { type: String, trim: true, maxlength: 240, default: '' },
    annualQuota: { type: Number, min: 0, max: 365, default: 0 },
    // Leave Without Pay has no balance to track.
    tracksBalance: { type: Boolean, default: true },
    // Restricted holiday leave can only be taken on a restricted holiday.
    restrictedHolidayOnly: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export default mongoose.model('LeaveType', leaveTypeSchema);
