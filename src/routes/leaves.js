import { Router } from 'express';
import { z } from 'zod';
import env from '../config/env.js';
import { applyLimiter } from '../middleware/security.js';
import { validate } from '../middleware/validate.js';
import Leave from '../models/Leave.js';
import { assessLeave } from '../services/leaves.js';
import { cleanAddresses } from '../services/contacts.js';
import {
  applicationDraft,
  applicationMail,
  cancellationMail,
  REASON_PLACEHOLDER,
  reasonFromLetter,
  requestSentence,
} from '../services/leaveMail.js';
import { newMessageId, sendMail } from '../services/mail.js';
import { range } from '../services/mailTemplates.js';
import { broadcastChange, getActiveAdmins, notifyUsers } from '../services/notify.js';
import { todayString, toDayString } from '../utils/dates.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/http.js';
import { day, email, idParams, objectId } from '../utils/schemas.js';

const router = Router();

const applyFields = {
  leaveTypeId: objectId,
  from: day,
  to: day,
  session: z.enum(['full', 'first', 'second']).default('full'),
};

const previewSchema = z.strictObject(applyFields);
// The app sends the mail text the employee wrote. A short reason alone still
// works and gets the usual letter around it.
const applySchema = z
  .strictObject({
    ...applyFields,
    reason: z.string().trim().min(3, 'Add a short reason').max(500, 'Keep the reason under 500 characters').optional(),
    subject: z
      .string()
      .trim()
      .min(3, 'Write a subject')
      .max(150, 'Keep the subject under 150 characters')
      .regex(/^[^\r\n]+$/, 'Keep the subject on one line')
      .optional(),
    message: z.string().trim().min(20, 'Write a few lines for your admin').max(4000, 'Keep the mail under 4000 characters').optional(),
    mailTo: z.array(email).min(1, 'Add at least one person in To').max(10, 'Send to at most 10 people').optional(),
    cc: z.array(email).max(15, 'Copy at most 15 people').optional(),
  })
  .refine((body) => body.reason || body.message, { message: 'Write the mail for your admin.', path: ['message'] });

router.post('/preview', validate({ body: previewSchema }), async (req, res) => {
  const { days, balance, leaveType } = await assessLeave(req.user, req.valid.body);
  const leave = { ...req.valid.body, days };
  res.json({
    days,
    tracksBalance: leaveType.tracksBalance,
    availableAfter: leaveType.tracksBalance ? balance.available - days : null,
    // The apply form builds the mail from these and swaps the sentence when the dates change.
    sentence: requestSentence(leave, leaveType.name),
    draft: applicationDraft({ employee: req.user, leave, typeName: leaveType.name }),
  });
});

router.post('/', applyLimiter, validate({ body: applySchema }), async (req, res) => {
  const { body } = req.valid;
  if (body.message?.includes(REASON_PLACEHOLDER)) {
    throw badRequest(`Write your reason in place of ${REASON_PLACEHOLDER}.`);
  }

  const { leaveType, holiday, from, to, days, year, session } = await assessLeave(req.user, body);

  const admins = await getActiveAdmins();
  const reviewers = admins.filter((admin) => admin.id !== req.user.id);
  const mailTo = reviewers.length ? reviewers : admins;
  // The employee may change To and CC. Without a choice, the admins get it.
  const chosenTo = body.mailTo ? cleanAddresses(body.mailTo, [req.user.email]) : undefined;
  if (chosenTo && chosenTo.length === 0) throw badRequest('Add at least one person other than you in To.');
  const cc = body.cc
    ? cleanAddresses(body.cc, [req.user.email, ...(chosenTo ?? mailTo.map((admin) => admin.email))])
    : undefined;

  const leave = await Leave.create({
    user: req.user.id,
    leaveType: leaveType.id,
    holiday: holiday?.id,
    from,
    to,
    session,
    days,
    year,
    reason: body.reason ?? reasonFromLetter(body.message),
    subject: body.subject,
    message: body.message,
    mailTo: chosenTo,
    cc,
    mailMessageId: newMessageId(),
  });

  res.status(201).json({ leave });

  const leaveJson = leave.toJSON();

  await notifyUsers(
    req.user.hidden ? [] : reviewers.map((admin) => admin.id),
    {
      kind: 'request',
      title: `${req.user.name} asked for ${days} ${days === 1 ? 'day' : 'days'} of leave`,
      body: `${leaveType.name}, ${range(leaveJson)}`,
      link: '/admin/requests?status=pending',
    },
  );

  broadcastChange();

  sendMail({
    ...applicationMail({
      employee: req.user,
      admins: mailTo,
      leave: leaveJson,
      typeName: leaveType.name,
    }),
    messageId: leave.mailMessageId,
  });
});

router.patch('/:id/cancel', validate({ params: idParams }), async (req, res) => {
  const leave = await Leave.findById(req.valid.params.id)
    .select('+mailMessageId')
    .populate('leaveType', 'name')
    .populate('user', 'name email employeeId designation phone role signatureHtml');

  if (!leave) throw notFound('That leave request was not found.');

  const isOwner = leave.user.id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) throw forbidden();

  if (!['pending', 'approved'].includes(leave.status)) {
    throw conflict(`This request is already ${leave.status}.`);
  }

  const started = toDayString(leave.from) <= todayString(env.TIMEZONE);
  if (leave.status === 'approved' && started && !isAdmin) {
    throw conflict('This leave has already started. Please ask an admin to change it.');
  }

  const updated = await Leave.findOneAndUpdate(
    { _id: leave.id, status: leave.status },
    { status: 'cancelled', cancelledBy: req.user.id, cancelledAt: new Date() },
    { returnDocument: 'after' },
  );
  if (!updated) throw conflict('This request just changed. Please refresh.');

  res.json({ leave: updated });

  const admins = await getActiveAdmins();
  const adminIds = admins.map((admin) => admin.id);
  const cancelledByAdmin = !isOwner;

  await notifyUsers(
    cancelledByAdmin ? [leave.user.id] : adminIds.filter((id) => id !== req.user.id),
    {
      kind: 'cancellation',
      title: cancelledByAdmin ? 'An admin cancelled your leave' : `${leave.user.name} cancelled a leave`,
      body: `${leave.leaveType.name}, ${range(updated.toJSON())}`,
      link: cancelledByAdmin ? '/requests' : '/admin/requests',
    },
  );

  broadcastChange();

  const others = admins.filter((admin) => admin.id !== leave.user.id);
  sendMail(
    cancellationMail({
      employee: leave.user,
      admins: others.length ? others : admins,
      cancelledBy: req.user,
      leave: { ...updated.toJSON(), mailMessageId: leave.mailMessageId },
    }),
  );
});

export default router;
