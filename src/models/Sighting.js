import mongoose from 'mongoose';
import crypto from 'crypto';

const sightingSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  person_id: { type: String, required: true, ref: 'Person' },
  camera_id: { type: String, required: true },
  camera_location: { type: String, default: null },
  detected_at: { type: Date, required: true },
  duration_seconds: { type: Number, default: null },
  bounding_box: { type: mongoose.Schema.Types.Mixed, default: {} },
  confidence_score: { type: Number, required: true, min: 0, max: 1 },
  face_trait_id: { type: String, ref: 'Trait', default: null },
  gait_trait_id: { type: String, ref: 'Trait', default: null },
  frame_number: { type: Number, default: null },
  video_source: { type: String, default: null },
  snapshot_path: { type: String, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Location fields
  person_latitude: { type: Number, default: null },
  person_longitude: { type: Number, default: null },
  person_altitude: { type: Number, default: null },
  distance_meters: { type: Number, default: null },
  heading_degrees: { type: Number, default: null },
  gaze_degrees: { type: Number, default: null },
  speed_ms: { type: Number, default: null },
  location_confidence: { type: Number, default: null },

  // Internal GeoJSON for 2dsphere queries
  person_location: {
    type: { type: String, enum: ['Point'] },
    coordinates: [Number] // [lon, lat]
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
  toJSON: {
    transform(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      delete ret.person_location;
      return ret;
    }
  },
  toObject: {
    transform(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      delete ret.person_location;
      return ret;
    }
  }
});

// Populate GeoJSON from lat/lon before save
sightingSchema.pre('save', function () {
  if (this.person_latitude != null && this.person_longitude != null) {
    this.person_location = {
      type: 'Point',
      coordinates: [this.person_longitude, this.person_latitude]
    };
  }
});

// After save: increment person total_sightings + update last_seen_at
sightingSchema.post('save', async function () {
  const Person = mongoose.model('Person');
  try {
    await Person.findByIdAndUpdate(this.person_id, {
      $inc: { total_sightings: 1 },
      $max: { last_seen_at: this.detected_at }
    });
  } catch (err) {
    // Non-fatal: log but don't fail the sighting creation
    console.error('Failed to update person sighting count:', err.message);
  }

  // Aggregate location if we have GPS data
  if (this.person_latitude != null && this.person_longitude != null) {
    try {
      await aggregatePersonLocation(this);
    } catch (err) {
      console.error('Failed to aggregate person location:', err.message);
    }
  }
});

async function aggregatePersonLocation(sighting) {
  const PersonLocation = mongoose.model('PersonLocation');
  const timeWindowMs = 5000;

  const windowStart = new Date(sighting.detected_at.getTime() - timeWindowMs);

  const existing = await PersonLocation.findOne({
    person_id: sighting.person_id,
    end_time: { $gte: windowStart },
    start_time: { $lte: sighting.detected_at }
  });

  if (existing) {
    const newCount = existing.sighting_count + 1;
    existing.end_time = sighting.detected_at;
    existing.avg_latitude = (existing.avg_latitude * existing.sighting_count + sighting.person_latitude) / newCount;
    existing.avg_longitude = (existing.avg_longitude * existing.sighting_count + sighting.person_longitude) / newCount;
    if (sighting.person_altitude != null) {
      existing.avg_altitude = existing.avg_altitude != null
        ? (existing.avg_altitude * existing.sighting_count + sighting.person_altitude) / newCount
        : sighting.person_altitude;
    }
    existing.heading_degrees = sighting.heading_degrees ?? existing.heading_degrees;
    existing.gaze_degrees = sighting.gaze_degrees ?? existing.gaze_degrees;
    existing.speed_ms = sighting.speed_ms ?? existing.speed_ms;
    existing.sighting_count = newCount;
    existing.confidence_score = Math.max(existing.confidence_score, sighting.location_confidence || 0.5);
    if (!existing.camera_ids.includes(sighting.camera_id)) {
      existing.camera_ids.push(sighting.camera_id);
    }
    await existing.save();
  } else {
    await PersonLocation.create({
      person_id: sighting.person_id,
      start_time: sighting.detected_at,
      end_time: sighting.detected_at,
      avg_latitude: sighting.person_latitude,
      avg_longitude: sighting.person_longitude,
      avg_altitude: sighting.person_altitude,
      heading_degrees: sighting.heading_degrees,
      gaze_degrees: sighting.gaze_degrees,
      speed_ms: sighting.speed_ms,
      sighting_count: 1,
      confidence_score: sighting.location_confidence || 0.5,
      camera_ids: [sighting.camera_id]
    });
  }
}

// Indexes
sightingSchema.index({ person_id: 1, detected_at: -1 });
sightingSchema.index({ camera_id: 1, detected_at: -1 });
sightingSchema.index({ detected_at: -1 });
sightingSchema.index({ person_id: 1, snapshot_path: 1, confidence_score: -1 });
sightingSchema.index({ person_location: '2dsphere' }, { sparse: true });

// Statics
sightingSchema.statics.recentSightings = async function (limit = 100) {
  return this.aggregate([
    { $match: { detected_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } },
    { $sort: { detected_at: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'persons',
        localField: 'person_id',
        foreignField: '_id',
        as: 'person'
      }
    },
    { $unwind: { path: '$person', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'cameras',
        localField: 'camera_id',
        foreignField: '_id',
        as: 'camera'
      }
    },
    { $unwind: { path: '$camera', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        sighting_id: '$_id',
        person_id: 1,
        display_name: '$person.display_name',
        external_id: '$person.external_id',
        camera_id: 1,
        detected_at: 1,
        confidence_score: 1,
        bounding_box: 1,
        person_latitude: 1,
        person_longitude: 1,
        distance_meters: 1,
        heading_degrees: 1,
        gaze_degrees: 1,
        speed_ms: 1,
        location_confidence: 1,
        camera_name: '$camera.name',
        camera_location: { $ifNull: ['$camera.location', '$camera_location'] },
        camera_latitude: '$camera.latitude',
        camera_longitude: '$camera.longitude'
      }
    }
  ]);
};

sightingSchema.statics.findPersonsNearLocation = async function (lat, lon, radiusMeters = 100) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  return this.aggregate([
    {
      $match: {
        person_location: {
          $nearSphere: {
            $geometry: { type: 'Point', coordinates: [lon, lat] },
            $maxDistance: radiusMeters
          }
        },
        detected_at: { $gte: oneHourAgo }
      }
    },
    {
      $group: {
        _id: '$person_id',
        last_seen: { $max: '$detected_at' },
        lat: { $last: '$person_latitude' },
        lon: { $last: '$person_longitude' }
      }
    },
    {
      $lookup: {
        from: 'persons',
        localField: '_id',
        foreignField: '_id',
        as: 'person'
      }
    },
    { $unwind: '$person' },
    {
      $project: {
        person_id: '$_id',
        display_name: '$person.display_name',
        last_seen: 1
      }
    }
  ]);
};

const Sighting = mongoose.model('Sighting', sightingSchema);

export default Sighting;
