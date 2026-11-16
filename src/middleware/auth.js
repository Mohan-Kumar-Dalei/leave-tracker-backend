import Department from '../models/Department.js';
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
  if (!user || !user.isActive || user.role === 'owner' || user.tokenVersion !== payload.v) {
    return next(unauthorized('Your session has expired.'));
  }

  req.user = user;
  return next();
}

// Admin pages are for department admins (managers and assistant managers) and
// for the owner (HR), who sees the whole company.
export function requireAdmin(req, _res, next) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'owner') return next(forbidden());
  return next();
}

// The Organisation page: the owner (HR), and a manager for the departments
// they run.
export async function requireOrganiser(req, _res, next) {
  try {
    if (req.user?.role === 'owner') return next();
    if (req.user?.role === 'admin' && (await Department.exists({ manager: req.user._id }))) return next();
    return next(forbidden());
  } catch (error) {
    return next(error);
  }
}

export function requireOwner(req, _res, next) {
  if (req.user?.role !== 'owner') return next(forbidden());
  return next();
}
