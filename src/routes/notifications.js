import { Router } from 'express';
import Notification from '../models/Notification.js';
import { openStream } from '../services/events.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../utils/schemas.js';

const router = Router();

router.get('/stream', openStream);

router.get('/', async (req, res) => {
  const [items, unread] = await Promise.all([
    Notification.find({ recipient: req.user.id }).sort({ createdAt: -1 }).limit(30),
    Notification.countDocuments({ recipient: req.user.id, readAt: null }),
  ]);
  res.json({ items, unread });
});

router.patch('/read-all', async (req, res) => {
  await Notification.updateMany({ recipient: req.user.id, readAt: null }, { readAt: new Date() });
  res.status(204).end();
});

router.patch('/:id/read', validate({ params: idParams }), async (req, res) => {
  await Notification.updateOne(
    { _id: req.valid.params.id, recipient: req.user.id },
    { readAt: new Date() },
  );
  res.status(204).end();
});

export default router;
