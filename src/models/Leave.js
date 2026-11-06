import mongoose from 'mongoose';
import { toDayString } from '../utils/dates.js';

const { ObjectId } = mongoose.Schema.Types;

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
export const ACTIVE_STATUSES = ['pending', 'approved'];

const leaveSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true, index: true },
    leaveType: { type: ObjectId, ref: 'LeaveType', required: true },
    holiday: { type: ObjectId, ref: 'Holiday' },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    session: { type: String, enum: ['full', 'first', 'second'], default: 'full' },
    days: { type: Number, required: true, min: 0.5 },
    year: { type: Number, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    status: { type: String, enum: LEAVE_STATUSES, default: 'pending', index: true },
    reviewedBy: { type: ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    reviewNote: { type: String, trim: true, maxlength: 300, default: '' },
    cancelledBy: { type: ObjectId, ref: 'User' },
    cancelledAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        ret.from = toDayString(ret.from);
        ret.to = toDayString(ret.to);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

leaveSchema.index({ user: 1, year: 1, status: 1 });
leaveSchema.index({ status: 1, createdAt: -1 });
leaveSchema.index({ from: 1, to: 1 });

// One restricted holiday can only be availed once by the same person.
leaveSchema.index(
  { user: 1, holiday: 1 },
  { unique: true, partialFilterExpression: { holiday: { $exists: true }, status: { $in: ACTIVE_STATUSES } } },
);

export default mongoose.model('Leave', leaveSchema);
