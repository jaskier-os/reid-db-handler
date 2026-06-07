import mongoose from 'mongoose';
import crypto from 'crypto';

const personLocationSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  person_id: { type: String, required: true, ref: 'Person' },
  start_time: { type: Date, required: true },
  end_time: { type: Date, required: true },
  avg_latitude: { type: Number, required: true },
  avg_longitude: { type: Number, required: true },
  avg_altitude: { type: Number, default: null },
  heading_degrees: { type: Number, default: null },
  gaze_degrees: { type: Number, default: null },
  speed_ms: { type: Number, default: null },
  distance_traveled: { type: Number, default: null },
  sighting_count: { type: Number, default: 1 },
  confidence_score: { type: Number, default: 0.5 },
  camera_ids: { type: [String], default: [] },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

  // GeoJSON for 2dsphere queries
  location: {
    type: { type: String, enum: ['Point'] },
    coordinates: [Number]
  }
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

personLocationSchema.pre('save', function () {
  if (this.avg_latitude != null && this.avg_longitude != null) {
    this.location = {
      type: 'Point',
      coordinates: [this.avg_longitude, this.avg_latitude]
    };
  }
});

personLocationSchema.index({ person_id: 1, end_time: -1 });
personLocationSchema.index({ location: '2dsphere' }, { sparse: true });

const PersonLocation = mongoose.model('PersonLocation', personLocationSchema);

export default PersonLocation;
