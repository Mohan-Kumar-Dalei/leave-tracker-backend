import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// A person's connected Gmail. The Google refresh token is stored encrypted
// (services/secretBox.js) and never leaves the server.
const gmailLinkSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true, unique: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    refreshToken: { type: String, required: true, select: false },
    scope: { type: String, default: '' },
    connectedAt: { type: Date, default: Date.now },
    lastSentAt: { type: Date },
    // Set when Google stops accepting the token, for example after a password
    // change or when a test app's 7 days run out. The person reconnects.
    brokenAt: { type: Date },
    brokenReason: { type: String, default: '' },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret._id;
        delete ret.__v;
        delete ret.refreshToken;
        return ret;
      },
    },
  },
);

export default mongoose.model('GmailLink', gmailLinkSchema);
