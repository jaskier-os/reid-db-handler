import mongoose from 'mongoose';
import crypto from 'crypto';

const traitSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  person_id: { type: String, required: true, ref: 'Person' },
  trait_type: { type: String, required: true, enum: ['face', 'gait', 'voice', 'iris'] },
  embedding: { type: Buffer, default: null },
  embedding_dimension: { type: Number, default: null },
  model_name: { type: String, default: null },
  model_version: { type: String, default: null },
  quality_score: {
    type: Number,
    default: null,
    validate: {
      validator: v => v === null || (v >= 0 && v <= 1),
      message: 'quality_score must be between 0 and 1'
    }
  },
  source_camera_id: { type: String, default: null },
  source_timestamp: { type: Date, default: null },
  source_metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  liveness_score: {
    type: Number,
    default: null,
    validate: {
      validator: v => v === null || (v >= 0 && v <= 1),
      message: 'liveness_score must be between 0 and 1'
    }
  },
  liveness_passed: { type: Boolean, default: null },
  similar_faces_processed: { type: mongoose.Schema.Types.Mixed, default: null }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
  toJSON: {
    transform(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      if (ret.embedding && Buffer.isBuffer(ret.embedding)) {
        ret.embedding = ret.embedding.toString('base64');
      }
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

traitSchema.index({ person_id: 1, trait_type: 1 });
traitSchema.index({ source_camera_id: 1 });
traitSchema.index({ created_at: -1 });

const Trait = mongoose.model('Trait', traitSchema);

export default Trait;
