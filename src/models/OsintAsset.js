import mongoose from 'mongoose';
import crypto from 'crypto';

const osintAssetSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  filename: { type: String, required: true },
  content_type: { type: String, required: true },
  asset_type: { type: String, enum: ['photo', 'report'], required: true },
  person_id: { type: String, default: null },
  source: { type: String, default: null },
  data: { type: Buffer, required: true }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  toJSON: {
    transform(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      delete ret.data;
      return ret;
    }
  },
  toObject: {
    transform(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      delete ret.data;
      return ret;
    }
  }
});

osintAssetSchema.index({ filename: 1 }, { unique: true });
osintAssetSchema.index({ person_id: 1 });
osintAssetSchema.index({ asset_type: 1 });
osintAssetSchema.index({ source: 1 });

const OsintAsset = mongoose.model('OsintAsset', osintAssetSchema);

export default OsintAsset;
