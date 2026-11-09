import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// One "Connect Gmail" attempt. The sign-in cookies are SameSite=Strict, so
// they do not come back with Google's redirect; this record says who started
// it. Single use, and MongoDB removes it after 10 minutes.
const oauthStateSchema = new mongoose.Schema({
  stateHash: { type: String, required: true, unique: true },
  user: { type: ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

export default mongoose.model('OAuthState', oauthStateSchema);
