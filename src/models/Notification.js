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
// A notification that has been read is removed an hour after it was read, so
// the collection stays small. Unread ones stay until someone reads them (or
// the 180 days above). MongoDB does the clearing itself, about once a minute.
export const READ_KEEP_SECONDS = 60 * 60;
notificationSchema.index({ readAt: 1 }, { expireAfterSeconds: READ_KEEP_SECONDS });

export default mongoose.model('Notification', notificationSchema);
