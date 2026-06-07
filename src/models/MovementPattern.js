import mongoose from 'mongoose';
import crypto from 'crypto';

const movementPatternSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  person_id: { type: String, required: true, ref: 'Person' },
  pattern_type: { type: String, required: true },
  start_time: { type: Date, required: true },
  end_time: { type: Date, required: true },
  duration_seconds: { type: Number, required: true },
  locations: { type: mongoose.Schema.Types.Mixed, required: true },
  bounding_box: { type: mongoose.Schema.Types.Mixed, default: null },
  total_distance: { type: Number, default: null },
  avg_speed: { type: Number, default: null },
  direction_changes: { type: Number, default: null },
  confidence_score: { type: Number, default: 0.5 },
  anomaly_score: { type: Number, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
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

movementPatternSchema.index({ person_id: 1 });
movementPatternSchema.index({ pattern_type: 1 });
movementPatternSchema.index({ start_time: -1 });

const MovementPattern = mongoose.model('MovementPattern', movementPatternSchema);

export default MovementPattern;
