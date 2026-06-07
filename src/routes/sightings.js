import Router from 'koa-router';
import Joi from 'joi';
import mongoose from 'mongoose';
import { Sighting, Person, PersonLocation } from '../models/index.js';
import logger from '../logger.js';

const router = new Router({ prefix: '/api/sightings' });

const createSightingSchema = Joi.object({
  person_id: Joi.string().required(),
  camera_id: Joi.string().required(),
  camera_location: Joi.string().optional(),
  detected_at: Joi.date().iso().required(),
  duration_seconds: Joi.number().integer().min(0).optional(),
  bounding_box: Joi.object().optional(),
  confidence_score: Joi.number().min(0).max(1).required(),
  face_trait_id: Joi.string().optional(),
  gait_trait_id: Joi.string().optional(),
  frame_number: Joi.number().integer().optional(),
  video_source: Joi.string().optional(),
  snapshot_path: Joi.string().optional(),
  metadata: Joi.object().optional(),
  person_latitude: Joi.number().optional(),
  person_longitude: Joi.number().optional(),
  person_altitude: Joi.number().optional(),
  distance_meters: Joi.number().optional(),
  heading_degrees: Joi.number().optional(),
  gaze_degrees: Joi.number().min(0).max(360).optional(),
  speed_ms: Joi.number().optional(),
  location_confidence: Joi.number().optional()
});

// GET /api/sightings
router.get('/', async (ctx) => {
  const { person_id, camera_id, limit = 100, offset = 0, recent = false } = ctx.query;

  const filter = {};
  if (person_id) filter.person_id = person_id;
  if (camera_id) filter.camera_id = camera_id;
  if (recent === 'true') {
    filter.detected_at = { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) };
  }

  const sightings = await Sighting.find(filter)
    .sort({ detected_at: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit));

  ctx.body = {
    sightings: sightings.map(s => s.toJSON()),
    count: sightings.length,
    limit: parseInt(limit),
    offset: parseInt(offset)
  };
});

// GET /api/sightings/snapshot-qualities
router.get('/snapshot-qualities', async (ctx) => {
  const results = await Sighting.aggregate([
    { $match: { snapshot_path: { $ne: null } } },
    { $group: {
      _id: '$person_id',
      best_confidence: { $max: '$confidence_score' }
    }},
    { $lookup: {
      from: 'persons',
      localField: '_id',
      foreignField: '_id',
      as: 'person'
    }},
    { $unwind: { path: '$person', preserveNullAndEmptyArrays: true } },
    { $project: {
      person_id: '$_id',
      external_id: '$person.external_id',
      best_confidence: 1,
      _id: 0
    }}
  ]);

  const qualities = {};
  for (const r of results) {
    const key = r.external_id || r.person_id;
    qualities[key] = r.best_confidence;
  }

  ctx.body = { qualities, count: results.length };
});

// GET /api/sightings/recent
router.get('/recent', async (ctx) => {
  const { limit = 100 } = ctx.query;

  const sightings = await Sighting.recentSightings(parseInt(limit));

  ctx.body = {
    sightings,
    count: sightings.length
  };
});

// GET /api/sightings/:id
router.get('/:id', async (ctx) => {
  const { id } = ctx.params;

  const sighting = await Sighting.findById(id);
  if (!sighting) {
    ctx.status = 404;
    ctx.body = { error: 'Sighting not found' };
    return;
  }

  ctx.body = sighting.toJSON();
});

// POST /api/sightings - uses model.save() so post('save') hooks fire
router.post('/', async (ctx) => {
  const { error, value } = createSightingSchema.validate(ctx.request.body);
  if (error) {
    ctx.status = 400;
    ctx.body = { error: error.details[0].message };
    return;
  }

  const sighting = new Sighting({
    person_id: value.person_id,
    camera_id: value.camera_id,
    camera_location: value.camera_location || null,
    detected_at: value.detected_at,
    duration_seconds: value.duration_seconds || null,
    bounding_box: value.bounding_box || {},
    confidence_score: value.confidence_score,
    face_trait_id: value.face_trait_id || null,
    gait_trait_id: value.gait_trait_id || null,
    frame_number: value.frame_number || null,
    video_source: value.video_source || null,
    snapshot_path: value.snapshot_path || null,
    metadata: value.metadata || {},
    person_latitude: value.person_latitude ?? null,
    person_longitude: value.person_longitude ?? null,
    person_altitude: value.person_altitude ?? null,
    distance_meters: value.distance_meters ?? null,
    heading_degrees: value.heading_degrees ?? null,
    gaze_degrees: value.gaze_degrees ?? null,
    speed_ms: value.speed_ms ?? null,
    location_confidence: value.location_confidence ?? null
  });

  await sighting.save();

  logger.info('Sighting created', {
    sighting_id: sighting._id,
    person_id: value.person_id,
    camera_id: value.camera_id
  });

  ctx.status = 201;
  ctx.body = sighting.toJSON();
});

// POST /api/sightings/batch
// insertMany does NOT fire post('save') hooks, so we manually handle person updates
router.post('/batch', async (ctx) => {
  const { sightings } = ctx.request.body;

  if (!Array.isArray(sightings) || sightings.length === 0) {
    ctx.status = 400;
    ctx.body = { error: 'sightings must be a non-empty array' };
    return;
  }

  for (const sighting of sightings) {
    const { error } = createSightingSchema.validate(sighting);
    if (error) {
      ctx.status = 400;
      ctx.body = { error: `Validation error: ${error.details[0].message}` };
      return;
    }
  }

  const session = await mongoose.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      const docs = sightings.map(s => {
        const doc = {
          person_id: s.person_id,
          camera_id: s.camera_id,
          camera_location: s.camera_location || null,
          detected_at: s.detected_at,
          duration_seconds: s.duration_seconds || null,
          bounding_box: s.bounding_box || {},
          confidence_score: s.confidence_score,
          face_trait_id: s.face_trait_id || null,
          gait_trait_id: s.gait_trait_id || null,
          frame_number: s.frame_number || null,
          video_source: s.video_source || null,
          snapshot_path: s.snapshot_path || null,
          metadata: s.metadata || {},
          person_latitude: s.person_latitude ?? null,
          person_longitude: s.person_longitude ?? null,
          person_altitude: s.person_altitude ?? null,
          distance_meters: s.distance_meters ?? null,
          heading_degrees: s.heading_degrees ?? null,
          gaze_degrees: s.gaze_degrees ?? null,
          speed_ms: s.speed_ms ?? null,
          location_confidence: s.location_confidence ?? null
        };
        if (doc.person_latitude != null && doc.person_longitude != null) {
          doc.person_location = {
            type: 'Point',
            coordinates: [doc.person_longitude, doc.person_latitude]
          };
        }
        return doc;
      });

      created = await Sighting.insertMany(docs, { session });

      const personCounts = {};
      const personLastSeen = {};
      for (const s of sightings) {
        personCounts[s.person_id] = (personCounts[s.person_id] || 0) + 1;
        const dt = new Date(s.detected_at);
        if (!personLastSeen[s.person_id] || dt > personLastSeen[s.person_id]) {
          personLastSeen[s.person_id] = dt;
        }
      }

      const bulkOps = Object.entries(personCounts).map(([personId, count]) => ({
        updateOne: {
          filter: { _id: personId },
          update: {
            $inc: { total_sightings: count },
            $max: { last_seen_at: personLastSeen[personId] }
          }
        }
      }));

      if (bulkOps.length > 0) {
        await Person.bulkWrite(bulkOps, { session });
      }

      const geoSightings = created.filter(s => s.person_latitude != null && s.person_longitude != null);
      if (geoSightings.length > 0) {
        await aggregateBatchLocations(geoSightings, session);
      }
    });

    logger.info('Batch sightings created', { count: created.length });

    ctx.status = 201;
    ctx.body = {
      created: created.length,
      sightings: created.map(s => s.toJSON())
    };
  } finally {
    session.endSession();
  }
});

async function aggregateBatchLocations(sightings, session) {
  const timeWindowMs = 5000;

  // Group by person_id
  const byPerson = {};
  for (const s of sightings) {
    if (!byPerson[s.person_id]) byPerson[s.person_id] = [];
    byPerson[s.person_id].push(s);
  }

  for (const [personId, personSightings] of Object.entries(byPerson)) {
    for (const s of personSightings) {
      const detectedAt = new Date(s.detected_at);
      const windowStart = new Date(detectedAt.getTime() - timeWindowMs);

      const existing = await PersonLocation.findOne({
        person_id: personId,
        end_time: { $gte: windowStart },
        start_time: { $lte: detectedAt }
      }).session(session);

      if (existing) {
        const newCount = existing.sighting_count + 1;
        existing.end_time = detectedAt;
        existing.avg_latitude = (existing.avg_latitude * existing.sighting_count + s.person_latitude) / newCount;
        existing.avg_longitude = (existing.avg_longitude * existing.sighting_count + s.person_longitude) / newCount;
        if (s.person_altitude != null) {
          existing.avg_altitude = existing.avg_altitude != null
            ? (existing.avg_altitude * existing.sighting_count + s.person_altitude) / newCount
            : s.person_altitude;
        }
        existing.heading_degrees = s.heading_degrees ?? existing.heading_degrees;
        existing.gaze_degrees = s.gaze_degrees ?? existing.gaze_degrees;
        existing.speed_ms = s.speed_ms ?? existing.speed_ms;
        existing.sighting_count = newCount;
        existing.confidence_score = Math.max(existing.confidence_score, s.location_confidence || 0.5);
        if (!existing.camera_ids.includes(s.camera_id)) {
          existing.camera_ids.push(s.camera_id);
        }
        await existing.save({ session });
      } else {
        const loc = new PersonLocation({
          person_id: personId,
          start_time: detectedAt,
          end_time: detectedAt,
          avg_latitude: s.person_latitude,
          avg_longitude: s.person_longitude,
          avg_altitude: s.person_altitude,
          heading_degrees: s.heading_degrees,
          gaze_degrees: s.gaze_degrees,
          speed_ms: s.speed_ms,
          sighting_count: 1,
          confidence_score: s.location_confidence || 0.5,
          camera_ids: [s.camera_id]
        });
        await loc.save({ session });
      }
    }
  }
}

// DELETE /api/sightings/:id
router.delete('/:id', async (ctx) => {
  const { id } = ctx.params;

  const sighting = await Sighting.findByIdAndDelete(id);
  if (!sighting) {
    ctx.status = 404;
    ctx.body = { error: 'Sighting not found' };
    return;
  }

  logger.info('Sighting deleted', { sighting_id: id });
  ctx.status = 204;
});

export default router;
