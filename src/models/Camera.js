import mongoose from 'mongoose';

const cameraSchema = new mongoose.Schema({
  _id: { type: String }, // camera id like "cam_01"
  name: { type: String, required: true },
  location: { type: String, default: null },
  location_coordinates: {
    type: { type: String, enum: ['Point'] },
    coordinates: [Number]
  },
  camera_type: { type: String, default: null },
  resolution: { type: String, default: null },
  frame_rate: { type: Number, default: null },
  is_active: { type: Boolean, default: true },
  last_active_at: { type: Date, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Calibration & GPS
  calibration_params: { type: mongoose.Schema.Types.Mixed, default: {} },
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  altitude: { type: Number, default: null },
  pan_angle: { type: Number, default: null },
  tilt_angle: { type: Number, default: null },
  camera_height: { type: Number, default: 2.5 }
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

cameraSchema.index({ is_active: 1 });
cameraSchema.index({ latitude: 1, longitude: 1 });
cameraSchema.index({ location_coordinates: '2dsphere' }, { sparse: true });

cameraSchema.statics.getActivity = async function () {
  const Sighting = mongoose.model('Sighting');

  return Sighting.aggregate([
    {
      $group: {
        _id: '$camera_id',
        unique_persons_detected: { $addToSet: '$person_id' },
        total_detections: { $sum: 1 },
        last_detection: { $max: '$detected_at' },
        avg_confidence: { $avg: '$confidence_score' }
      }
    },
    {
      $lookup: {
        from: 'cameras',
        localField: '_id',
        foreignField: '_id',
        as: 'camera'
      }
    },
    { $unwind: { path: '$camera', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        camera_id: '$_id',
        camera_name: '$camera.name',
        location: '$camera.location',
        is_active: '$camera.is_active',
        unique_persons_detected: { $size: '$unique_persons_detected' },
        total_detections: 1,
        last_detection: 1,
        avg_confidence: 1
      }
    }
  ]);
};

const Camera = mongoose.model('Camera', cameraSchema);

export default Camera;
