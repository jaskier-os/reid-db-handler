import mongoose from 'mongoose';
import crypto from 'crypto';

const face3dFramesSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  person_id: { type: String, required: true },
  frame_count: { type: Number, default: 0 },
  last_built_at_count: { type: Number, default: 0 },
  frames: { type: Buffer, default: null },
  schema_version: { type: Number, default: 1 }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  toJSON: {
    transform(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      return ret;
    }
  },
  toObject: {
    transform(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      return ret;
    }
  }
});

face3dFramesSchema.index({ person_id: 1 }, { unique: true });

const Face3DFrames = mongoose.model('Face3DFrames', face3dFramesSchema);

export default Face3DFrames;
