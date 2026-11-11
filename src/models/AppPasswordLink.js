import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// A Gmail App Password a person saved, so their leave mails go out over
// Gmail's SMTP from their own address. Stored encrypted (services/secretBox.js)
// and never sent back to the browser.
const appPasswordLinkSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true, unique: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    connectedAt: { type: Date, default: Date.now },
    lastSentAt: { type: Date },
    // Set when Google stops accepting it, for example after a password change.
    brokenAt: { type: Date },
    brokenReason: { type: String, default: '' },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret._id;
        delete ret.__v;
        delete ret.password;
        return ret;
      },
    },
  },
);

export default mongoose.model('AppPasswordLink', appPasswordLinkSchema);
