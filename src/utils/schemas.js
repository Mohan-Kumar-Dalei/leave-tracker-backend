import { z } from 'zod';
import { isRealDay } from './dates.js';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
export const idParams = z.strictObject({ id: objectId });
export const day = z.string().refine(isRealDay, 'Use a valid date in YYYY-MM-DD format');
export const year = z.coerce.number().int().min(2000).max(2100);
export const page = z.coerce.number().int().min(1).max(100000);
export const limit = z.coerce.number().int().min(1).max(500);
export const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(160);

export const password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(72, 'Use at most 72 characters')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/\d/, 'Include at least one number');
