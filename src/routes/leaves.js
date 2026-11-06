import { Router } from 'express';
import { z } from 'zod';
import env from '../config/env.js';
import { applyLimiter } from '../middleware/security.js';
import { validate } from '../middleware/validate.js';
import Leave from '../models/Leave.js';
import { assessLeave } from '../services/leaves.js';
import { sendMail } from '../services/mail.js';
import { cancelledMail, newRequestMail, range } from '../services/mailTemplates.js';
import { broadcastChange, getActiveAdmins, notifyUsers } from '../services/notify.js';
import { todayString, toDayString } from '../utils/dates.js';
import { conflict, forbidden, notFound } from '../utils/http.js';
import { day, idParams, objectId } from '../utils/schemas.js';

const router = Router();

const applyFields = {
  leaveTypeId: objectId,
  from: day,
  to: day,
  session: z.enum(['full', 'first', 'second']).default('full'),
};

const previewSchema = z.strictObject(applyFields);
const applySchema = z.strictObject({
  ...applyFields,
  reason: z.string().trim().min(3, 'Add a short reason').max(500, 'Keep the reason under 500 characters'),
});

router.post('/preview', validate({ body: previewSchema }), async (req, res) => {
  const { days, balance, leaveType } = await assessLeave(req.user, req.valid.body);
  res.json({
    days,
    tracksBalance: leaveType.tracksBalance,
    availableAfter: leaveType.tracksBalance ? balance.available - days : null,
  });
});

router.post('/', applyLimiter, validate({ body: applySchema }), async (req, res) => {
  const { body } = req.valid;
  const { leaveType, holiday, from, to, days, year, session } = await assessLeave(req.user, body);

  const leave = await Leave.create({
    user: req.user.id,
    leaveType: leaveType.id,
    holiday: holiday?.id,
    from,
    to,
    session,
    days,
    year,
    reason: body.reason,
  });

  res.status(201).json({ leave });

  const admins = await getActiveAdmins();
  const reviewers = admins.filter((admin) => admin.id !== req.user.id);
  const leaveJson = leave.toJSON();

  await notifyUsers(
    reviewers.map((admin) => admin.id),
    {
      kind: 'request',
      title: `${req.user.name} asked for ${days} ${days === 1 ? 'day' : 'days'} of leave`,
      body: `${leaveType.name}, ${range(leaveJson)}`,
      link: '/admin/requests?status=pending',
    },
  );

  broadcastChange();

  const mail = newRequestMail({ employee: req.user, leave: leaveJson, typeName: leaveType.name });
  for (const admin of reviewers) sendMail({ to: admin.email, ...mail });
});

router.patch('/:id/cancel', validate({ params: idParams }), async (req, res) => {
  const leave = await Leave.findById(req.valid.params.id)
    .populate('leaveType', 'name')
    .populate('user', 'name email employeeId');

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

  const mail = cancelledMail({
    employee: leave.user,
    leave: updated.toJSON(),
    typeName: leave.leaveType.name,
    cancelledByAdmin,
  });
  const recipients = cancelledByAdmin ? [leave.user.email] : admins.map((admin) => admin.email);
  for (const to of recipients) sendMail({ to, ...mail });
});

export default router;
