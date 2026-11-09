import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['request', 'decision', 'cancellation', 'balance', 'gmail'], required: true },
    title: { type: String, required: true, maxlength: 140 },
    body: { type: String, maxlength: 400, default: '' },
    link: { type: String, maxlength: 200, default: '' },
    readAt: { type: Date },
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

notificationSchema.index({ recipient: 1, createdAt: -1 });
// Old notifications clear themselves after 180 days.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

export default mongoose.model('Notification', notificationSchema);
