import mongoose from 'mongoose';
import { toDayString } from '../utils/dates.js';

const holidaySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    date: { type: Date, required: true, unique: true },
    restricted: { type: Boolean, default: false },
    note: { type: String, trim: true, maxlength: 200, default: '' },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        ret.date = toDayString(ret.date);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export default mongoose.model('Holiday', holidaySchema);
