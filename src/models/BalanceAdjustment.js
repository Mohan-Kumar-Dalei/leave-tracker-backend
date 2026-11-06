import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// Credits and debits made by an admin, for example comp off for weekend work.
const balanceAdjustmentSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    leaveType: { type: ObjectId, ref: 'LeaveType', required: true },
    year: { type: Number, required: true },
    days: { type: Number, required: true, min: -365, max: 365 },
    reason: { type: String, required: true, trim: true, maxlength: 240 },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    // Set when the employee closes the banner. An edit clears it again.
    dismissedAt: { type: Date },
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

balanceAdjustmentSchema.index({ user: 1, year: 1 });

export default mongoose.model('BalanceAdjustment', balanceAdjustmentSchema);
