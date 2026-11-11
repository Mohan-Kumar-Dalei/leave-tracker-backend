import { gunzipSync } from 'node:zlib';
import { Router } from 'express';
import { z } from 'zod';
import env from '../config/env.js';
import { appPasswordLimiter } from '../middleware/security.js';
import { validate } from '../middleware/validate.js';
import AppPasswordLink from '../models/AppPasswordLink.js';
import BalanceAdjustment from '../models/BalanceAdjustment.js';
import Holiday from '../models/Holiday.js';
import Leave, { ACTIVE_STATUSES, LEAVE_STATUSES } from '../models/Leave.js';
import { getBalances, getMonthlyUsage } from '../services/balances.js';
import { mailContacts } from '../services/contacts.js';
import GmailLink from '../models/GmailLink.js';
import OAuthState from '../models/OAuthState.js';
import { STATE_COOKIE, STATE_COOKIE_PATH } from './google.js';
import { authUrl, disconnect } from '../services/gmail.js';
import {
  appPasswordAvailable,
  checkAppPassword,
  looksLikeAppPassword,
  removeAppPassword,
  saveAppPassword,
} from '../services/appPassword.js';
import { deleteFile, fileDetails, isUsableAvatar, uploadAuth } from '../services/imagekit.js';
import User from '../models/User.js';
import { randomToken, sha256 } from '../services/tokens.js';
import { cleanSignature, MAX_SIGNATURE_LENGTH } from '../services/signature.js';
import { APPLICATION_SUBJECT, designationOf, signatureData } from '../services/leaveMail.js';
import { isWeekend } from '../services/leaveDays.js';
import { toDayString, todayString, yearRange } from '../utils/dates.js';
import { badRequest, pageMeta, paginate, toCsv } from '../utils/http.js';
import { idParams, limit, page, phone, year } from '../utils/schemas.js';

const router = Router();

const currentYear = () => Number(todayString(env.TIMEZONE).slice(0, 4));

const reviewerFields = 'name';
const typeFields = 'name code tracksBalance restrictedHolidayOnly';

function leaveEntry(leave) {
  const json = leave.toJSON();
  return {
    kind: 'leave',
    id: json.id,
    from: json.from,
    to: json.to,
    title: leave.leaveType?.name ?? 'Leave',
    typeCode: leave.leaveType?.code,
    days: json.days,
    session: json.session,
    status: json.status,
    reason: json.reason,
  };
}

function holidayEntry(holiday, availedIds, rhAvailable) {
  const json = holiday.toJSON();
  const availed = availedIds.has(json.id);
  return {
    kind: 'holiday',
    id: json.id,
    from: json.date,
    to: json.date,
    title: json.name,
    note: json.note,
    restricted: json.restricted,
    availed,
    // A restricted holiday on a weekly off is already a day off.
    canAvail: json.restricted && !availed && rhAvailable > 0 && !isWeekend(holiday.date),
  };
}

router.get(
  '/summary',
  validate({ query: z.object({ year: year.optional() }) }),
  async (req, res) => {
    const selectedYear = req.valid.query.year ?? currentYear();
    const { start, end } = yearRange(selectedYear);
    const today = todayString(env.TIMEZONE);

    const [balances, leaves, holidays, monthly, adjustments] = await Promise.all([
      getBalances(req.user.id, selectedYear),
      Leave.find({ user: req.user.id, year: selectedYear, status: { $in: ACTIVE_STATUSES } })
        .populate('leaveType', typeFields)
        .sort({ from: 1 }),
      Holiday.find({ date: { $gte: start, $lte: end } }).sort({ date: 1 }),
      getMonthlyUsage(req.user.id, selectedYear),
      BalanceAdjustment.find({ user: req.user.id, year: selectedYear, dismissedAt: null })
        .populate('leaveType', 'name')
        .populate('createdBy', 'name')
        .sort({ updatedAt: -1 }),
    ]);

    const rhBalance = balances.find((balance) => balance.leaveType.restrictedHolidayOnly);
    const availedIds = new Set(leaves.filter((l) => l.holiday).map((l) => String(l.holiday)));

    const entries = [
      ...leaves.map(leaveEntry),
      ...holidays.map((holiday) => holidayEntry(holiday, availedIds, rhBalance?.available ?? 0)),
    ];

    const upcoming = entries
      .filter((entry) => entry.to >= today)
      .sort((a, b) => a.from.localeCompare(b.from));
    const past = entries
      .filter((entry) => entry.to < today)
      .sort((a, b) => b.from.localeCompare(a.from));

    const bookedThisYear = balances.reduce((sum, balance) => sum + balance.booked, 0);
    const absent = balances
      .filter((balance) => !balance.leaveType.tracksBalance)
      .reduce((sum, balance) => sum + balance.earlier + balance.approved, 0);

    res.json({
      year: selectedYear,
      today,
      bookedThisYear,
      absent,
      balances,
      monthly,
      adjustments: adjustments.map((item) => ({
        id: item.id,
        leaveType: item.leaveType?.name,
        days: item.days,
        reason: item.reason,
        by: item.createdBy?.name,
        date: todayString(env.TIMEZONE, item.updatedAt),
      })),
      upcoming,
      past,
      restrictedHolidayTypeId: rhBalance?.leaveType.id ?? null,
    });
  },
);

router.get(
  '/leaves',
  validate({
    query: z.object({
      status: z.enum(LEAVE_STATUSES).optional(),
      year: year.optional(),
      page: page.optional(),
      limit: limit.optional(),
    }),
  }),
  async (req, res) => {
    const { status, year: selectedYear } = req.valid.query;
    const pageInfo = paginate(req.valid.query);

    const filter = { user: req.user.id };
    if (status) filter.status = status;
    if (selectedYear) filter.year = selectedYear;

    const [items, total] = await Promise.all([
      Leave.find(filter)
        .populate('leaveType', typeFields)
        .populate('reviewedBy', reviewerFields)
        .sort({ createdAt: -1 })
        .skip(pageInfo.skip)
        .limit(pageInfo.limit),
      Leave.countDocuments(filter),
    ]);

    res.json({ items, ...pageMeta(total, pageInfo) });
  },
);

router.get(
  '/leaves.csv',
  validate({ query: z.object({ year: year.optional() }) }),
  async (req, res) => {
    const selectedYear = req.valid.query.year ?? currentYear();
    const leaves = await Leave.find({ user: req.user.id, year: selectedYear })
      .populate('leaveType', 'name')
      .sort({ from: 1 });

    const csv = toCsv(
      ['From', 'To', 'Leave type', 'Days', 'Status', 'Reason'],
      leaves.map((leave) => [
        toDayString(leave.from),
        toDayString(leave.to),
        leave.leaveType?.name,
        leave.days,
        leave.status,
        leave.reason,
      ]),
    );

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="my-leave-${selectedYear}.csv"`);
    res.send(`﻿${csv}`);
  },
);

router.patch('/adjustments/:id/dismiss', validate({ params: idParams }), async (req, res) => {
  await BalanceAdjustment.updateOne({ _id: req.valid.params.id, user: req.user.id }, { dismissedAt: new Date() });
  res.status(204).end();
});

// What the apply form and the admin's reply box need to show the mail before
// it goes: who it is to, who is copied by default, who else can be copied, and
// the signature.
router.get('/compose', async (req, res) => {
  const { contacts, users } = await mailContacts();
  const admins = users.filter((user) => user.role === 'admin' && user.id !== req.user.id);
  const to = admins.map((admin) => admin.email);

  res.json({
    greeting: env.LEAVE_MAIL_GREETING,
    subject: APPLICATION_SUBJECT,
    to: admins.map(({ name, email }) => ({ name, email })),
    defaultCc: env.leaveMailContacts.filter((contact) => contact.email !== req.user.email && !to.includes(contact.email)),
    contacts: contacts.filter((contact) => contact.email !== req.user.email),
    signature: {
      ...signatureData(),
      name: req.user.name,
      designation: designationOf(req.user),
      phone: req.user.phone,
      email: req.user.email,
      customHtml: req.user.signatureHtml,
    },
  });
});

const MAX_SIGNATURE_GZIP = 12000;
// Unpacking stops at this size, so a small upload cannot expand into a huge one.
const MAX_SIGNATURE_UNPACKED = 200000;

function unpackSignature(packed) {
  if (!packed) return '';
  try {
    return gunzipSync(Buffer.from(packed, 'base64'), { maxOutputLength: MAX_SIGNATURE_UNPACKED }).toString('utf8');
  } catch {
    throw badRequest('That signature could not be read. Paste it again.');
  }
}

/* Profile photo */

// A single use signature for one upload straight to ImageKit.
router.get('/photo/upload-auth', (req, res) => {
  if (!env.imagekitEnabled) throw badRequest('Profile photos are not set up on this server yet.');
  res.json({ ...uploadAuth(req.user.id), urlEndpoint: env.IMAGEKIT_URL_ENDPOINT });
});

// Saves the uploaded file as the photo once ImageKit confirms it is ours.
router.post(
  '/photo',
  validate({ body: z.strictObject({ fileId: z.string().trim().min(5).max(64).regex(/^[A-Za-z0-9_-]+$/) }) }),
  async (req, res) => {
    if (!env.imagekitEnabled) throw badRequest('Profile photos are not set up on this server yet.');
    const details = await fileDetails(req.valid.body.fileId);
    if (!isUsableAvatar(details)) {
      if (details?.fileId) await deleteFile(details.fileId);
      throw badRequest('That picture could not be used. Upload a JPG or PNG under 2 MB.');
    }

    const user = await User.findById(req.user.id).select('+avatarFileId');
    const previous = user.avatarFileId;
    user.avatarUrl = details.url;
    user.avatarFileId = details.fileId;
    await user.save();
    if (previous && previous !== details.fileId) await deleteFile(previous);

    res.json({ user });
  },
);

router.delete('/photo', async (req, res) => {
  const user = await User.findById(req.user.id).select('+avatarFileId');
  if (user.avatarFileId && env.imagekitEnabled) await deleteFile(user.avatarFileId);
  user.avatarUrl = '';
  user.avatarFileId = '';
  await user.save();
  res.json({ user });
});

/* Connect Gmail */

const STATE_MINUTES = 10;

// Whether the person's leave mails go from their own Gmail.
router.get('/gmail', async (req, res) => {
  const [link, appLink] = await Promise.all([
    env.gmailEnabled ? GmailLink.findOne({ user: req.user.id }) : null,
    appPasswordAvailable() ? AppPasswordLink.findOne({ user: req.user.id }) : null,
  ]);
  res.json({
    available: env.gmailEnabled,
    connected: Boolean(link && !link.brokenAt),
    email: link?.email ?? null,
    needsReconnect: Boolean(link?.brokenAt),
    lastSentAt: link?.lastSentAt ?? null,
    appPassword: {
      available: appPasswordAvailable(),
      connected: Boolean(appLink && !appLink.brokenAt),
      email: appLink?.email ?? req.user.email,
      needsReconnect: Boolean(appLink?.brokenAt),
      lastSentAt: appLink?.lastSentAt ?? null,
    },
  });
});

// The App Password way: it must sign in to Gmail as the person's own address
// before it is saved. It is never sent back.
router.post(
  '/gmail/app-password',
  appPasswordLimiter,
  validate({ body: z.strictObject({ appPassword: z.string().max(40) }) }),
  async (req, res) => {
    if (!appPasswordAvailable()) throw badRequest('Sending with an App Password is not set up on this server yet.');
    const { appPassword } = req.valid.body;
    if (!looksLikeAppPassword(appPassword)) {
      throw badRequest('An App Password is 16 letters, shown by Google in four groups of four.');
    }

    const check = await checkAppPassword(req.user.email, appPassword);
    if (!check.ok) {
      throw badRequest(
        check.rejected
          ? `Google did not accept that App Password for ${req.user.email}. Make one for this exact Gmail and try again.`
          : 'Could not reach Gmail to check it. Please try again in a minute.',
      );
    }

    await saveAppPassword(req.user.id, req.user.email, appPassword);
    res.json({ connected: true, email: req.user.email });
  },
);

router.delete('/gmail/app-password', async (req, res) => {
  await removeAppPassword(req.user.id);
  res.status(204).end();
});

// Starts "Connect Gmail". The page then goes to the returned Google address.
router.post('/gmail/connect', async (req, res) => {
  if (!env.gmailEnabled) throw badRequest('Sending from your own Gmail is not set up on this server yet.');

  const state = randomToken();
  await OAuthState.create({
    stateHash: sha256(state),
    user: req.user.id,
    expiresAt: new Date(Date.now() + STATE_MINUTES * 60 * 1000),
  });
  // Lax, so it comes back with Google's redirect to the callback.
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: STATE_COOKIE_PATH,
    maxAge: STATE_MINUTES * 60 * 1000,
  });
  res.json({ url: authUrl({ state, loginHint: req.user.email }) });
});

router.delete('/gmail', async (req, res) => {
  await disconnect(req.user.id);
  res.status(204).end();
});

// Everyone keeps their own name, phone, designation and department up to date,
// along with the signature their leave mails end with. Email and employee ID
// stay with the admin.
router.patch(
  '/profile',
  validate({
    body: z.strictObject({
      name: z.string().trim().min(2, 'Enter your full name').max(80).optional(),
      phone: phone.optional(),
      designation: z.string().trim().max(80).optional(),
      department: z.string().trim().max(60).optional(),
      signatureHtml: z.string().max(100000, 'That signature is too long').optional(),
      // The app sends the signature gzipped and base64 encoded. Pasted HTML is
      // full of style attributes and often over 8 KB, which the hosting
      // firewall blocks in a request body. It is unpacked and cleaned here.
      signatureGzip: z
        .string()
        .max(MAX_SIGNATURE_GZIP, 'That signature is too long. Paste it without large pictures.')
        .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'That signature could not be read.')
        .optional(),
    }),
  }),
  async (req, res) => {
    const { name, phone: phoneNumber, designation, department, signatureGzip } = req.valid.body;
    const signatureHtml = signatureGzip !== undefined ? unpackSignature(signatureGzip) : req.valid.body.signatureHtml;
    if (name !== undefined) req.user.name = name;
    if (phoneNumber !== undefined) req.user.phone = phoneNumber;
    if (designation !== undefined) req.user.designation = designation;
    if (department !== undefined) req.user.department = department;
    if (signatureHtml !== undefined) {
      const cleaned = cleanSignature(signatureHtml);
      if (cleaned.length > MAX_SIGNATURE_LENGTH) {
        throw badRequest('That signature is too long. Paste it without large pictures.');
      }
      req.user.signatureHtml = cleaned;
    }
    await req.user.save();
    res.json({ user: req.user });
  },
);

export default router;
