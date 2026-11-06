import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Leave taken before this system existed. The old sheet has monthly totals but
// no dates, so it is kept as totals instead of inventing leave records.
const importedUsageSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    leaveType: { type: ObjectId, ref: 'LeaveType', required: true },
    year: { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    days: { type: Number, required: true, min: 0, max: 31 },
  },
  { timestamps: true },
);

importedUsageSchema.index({ user: 1, leaveType: 1, year: 1, month: 1 }, { unique: true });

export default mongoose.model('ImportedUsage', importedUsageSchema);
