import User from '../models/User.js';
import { verifyAccessToken, ACCESS_COOKIE } from '../services/tokens.js';
import { forbidden, unauthorized } from '../utils/http.js';

// The user is loaded on every request so that deactivating someone or changing
// a password takes effect at once, not when their access token expires.
export async function requireAuth(req, _res, next) {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (!token) return next(unauthorized());

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return next(unauthorized('Your session has expired.'));
  }

  const user = await User.findById(payload.sub).select('+tokenVersion');
  if (!user || !user.isActive || user.tokenVersion !== payload.v) {
    return next(unauthorized('Your session has expired.'));
  }

  req.user = user;
  return next();
}

export function requireAdmin(req, _res, next) {
  if (req.user?.role !== 'admin') return next(forbidden());
  return next();
}
