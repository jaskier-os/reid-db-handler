import mongoose from 'mongoose';
import crypto from 'crypto';

const personRelationshipSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  person_a_id: { type: String, required: true, ref: 'Person' },
  person_b_id: { type: String, required: true, ref: 'Person' },
  relationship_type: { type: String, required: true },
  similarity_score: { type: Number, default: null, min: 0, max: 1 },
  verified: { type: Boolean, default: false },
  verified_by: { type: String, default: null },
  verified_at: { type: Date, default: null },
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

personRelationshipSchema.pre('save', function (next) {
  if (this.person_a_id === this.person_b_id) {
    next(new Error('person_a_id and person_b_id must be different'));
  } else {
    next();
  }
});

personRelationshipSchema.index({ person_a_id: 1 });
personRelationshipSchema.index({ person_b_id: 1 });
personRelationshipSchema.index({ relationship_type: 1 });
personRelationshipSchema.index({ similarity_score: -1 });

const PersonRelationship = mongoose.model('PersonRelationship', personRelationshipSchema);

export default PersonRelationship;
