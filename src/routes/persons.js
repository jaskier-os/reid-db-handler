import Router from 'koa-router';
import Joi from 'joi';
import mongoose from 'mongoose';
import { Person, Trait, Sighting } from '../models/index.js';
import { getFaissService } from '../services/faiss-service.js';
import { mergePersons } from '../services/merge-service.js';
import logger from '../logger.js';

const router = new Router({ prefix: '/api/persons' });

const createPersonSchema = Joi.object({
  external_id: Joi.string().optional(),
  display_name: Joi.string().optional(),
  metadata: Joi.object().optional()
});

const updatePersonSchema = Joi.object({
  external_id: Joi.string().optional(),
  display_name: Joi.string().optional(),
  is_active: Joi.boolean().optional(),
  metadata: Joi.object().optional()
});

// GET /api/persons
router.get('/', async (ctx) => {
  const { limit = 100, offset = 0, is_active } = ctx.query;

  const filter = {};
  if (is_active !== undefined) {
    filter.is_active = is_active === 'true' ? { $ne: false } : false;
  }

  const persons = await Person.find(filter)
    .sort({ last_seen_at: -1, created_at: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit))
    .lean();

  // Transform _id -> id
  const transformed = persons.map(p => {
    p.id = p._id;
    delete p._id;
    delete p.__v;
    return p;
  });

  ctx.body = {
    persons: transformed,
    count: transformed.length,
    limit: parseInt(limit),
    offset: parseInt(offset)
  };
});

// GET /api/persons/search?q=query&limit=20&offset=0
router.get('/search', async (ctx) => {
  const { q, limit = 20, offset = 0 } = ctx.query;

  if (!q || q.trim().length === 0) {
    ctx.status = 400;
    ctx.body = { error: 'Query parameter "q" is required' };
    return;
  }

  const query = q.trim();
  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  const cappedLimit = Math.min(parseInt(limit), 100);
  const persons = await Person.find({
    $or: [
      { display_name: regex },
      { external_id: regex },
      { 'search_keys.value': regex }
    ]
  })
    .sort({ last_seen_at: -1 })
    .skip(parseInt(offset))
    .limit(cappedLimit)
    .lean();

  const transformed = persons.map(p => {
    p.id = p._id;
    delete p._id;
    delete p.__v;
    return p;
  });

  ctx.body = {
    persons: transformed,
    count: transformed.length,
    limit: parseInt(limit),
    offset: parseInt(offset)
  };
});

// GET /api/persons/cross-search?type=phone&value=79125036666
router.get('/cross-search', async (ctx) => {
  const { type, value } = ctx.query;

  if (!type || !value) {
    ctx.status = 400;
    ctx.body = { error: 'Both "type" and "value" query parameters are required' };
    return;
  }

  const persons = await Person.find({
    'search_keys.type': type,
    'search_keys.value': value
  }).lean();

  const transformed = persons.map(p => {
    p.id = p._id;
    delete p._id;
    delete p.__v;
    return p;
  });

  ctx.body = { persons: transformed, count: transformed.length };
});

// GET /api/persons/:id
router.get('/:id', async (ctx) => {
  const { id } = ctx.params;

  const person = await Person.findById(id);
  if (!person) {
    ctx.status = 404;
    ctx.body = { error: 'Person not found' };
    return;
  }

  ctx.body = person.toJSON();
});

// POST /api/persons
router.post('/', async (ctx) => {
  const { error, value } = createPersonSchema.validate(ctx.request.body);
  if (error) {
    ctx.status = 400;
    ctx.body = { error: error.details[0].message };
    return;
  }

  const { external_id, display_name, metadata = {} } = value;

  try {
    const person = await Person.create({
      external_id: external_id || null,
      display_name: display_name || null,
      metadata
    });

    logger.info('Person created', { person_id: person._id });

    ctx.status = 201;
    ctx.body = person.toJSON();
  } catch (err) {
    if (err.code === 11000) {
      ctx.status = 409;
      ctx.body = {
        error: 'Person with this external_id already exists',
        code: 'DUPLICATE_EXTERNAL_ID'
      };
    } else {
      throw err;
    }
  }
});

// POST /api/persons/find-or-create
router.post('/find-or-create', async (ctx) => {
  const { error, value } = createPersonSchema.validate(ctx.request.body);
  if (error) {
    ctx.status = 400;
    ctx.body = { error: error.details[0].message };
    return;
  }

  const { external_id, display_name, metadata = {} } = value;

  if (!external_id) {
    ctx.status = 400;
    ctx.body = { error: 'external_id is required for find-or-create' };
    return;
  }

  const existing = await Person.findOne({ external_id });
  if (existing) {
    logger.debug('Person found by external_id', { external_id, person_id: existing._id });
    ctx.body = { ...existing.toJSON(), created: false };
    return;
  }

  const person = await Person.create({
    external_id,
    display_name: display_name || null,
    metadata
  });

  logger.info('Person created via find-or-create', { external_id, person_id: person._id });

  ctx.status = 201;
  ctx.body = { ...person.toJSON(), created: true };
});

// PUT /api/persons/:id
router.put('/:id', async (ctx) => {
  const { id } = ctx.params;
  const { error, value } = updatePersonSchema.validate(ctx.request.body);

  if (error) {
    ctx.status = 400;
    ctx.body = { error: error.details[0].message };
    return;
  }

  if (Object.keys(value).length === 0) {
    ctx.status = 400;
    ctx.body = { error: 'No fields to update' };
    return;
  }

  const person = await Person.findByIdAndUpdate(id, { $set: value }, { new: true });

  if (!person) {
    ctx.status = 404;
    ctx.body = { error: 'Person not found' };
    return;
  }

  logger.info('Person updated', { person_id: id });

  ctx.body = person.toJSON();
});

// PUT /api/persons/:id/information
const updateInformationSchema = Joi.object({
  source: Joi.string().required(),
  data: Joi.object().required()
});

router.put('/:id/information', async (ctx) => {
  const { id } = ctx.params;
  const { error, value } = updateInformationSchema.validate(ctx.request.body);

  if (error) {
    ctx.status = 400;
    ctx.body = { error: error.details[0].message };
    return;
  }

  const person = await Person.findById(id);
  if (!person) {
    ctx.status = 404;
    ctx.body = { error: 'Person not found' };
    return;
  }

  if (!person.information_found) {
    person.information_found = {};
  }
  person.information_found[value.source] = value.data;
  person.markModified('information_found');

  person.search_keys = Person.extractSearchKeys(person.information_found);

  await person.save();

  logger.info('Person information updated', { person_id: id, source: value.source, search_keys_count: person.search_keys.length });

  ctx.body = person.toJSON();
});

// GET /api/persons/:id/cross-search
router.get('/:id/cross-search', async (ctx) => {
  const { id } = ctx.params;

  const person = await Person.findById(id, 'search_keys').lean();
  if (!person) {
    ctx.status = 404;
    ctx.body = { error: 'Person not found' };
    return;
  }

  if (!person.search_keys || person.search_keys.length === 0) {
    ctx.body = { persons: [], count: 0 };
    return;
  }

  const orConditions = person.search_keys.map(k => ({
    'search_keys.type': k.type,
    'search_keys.value': k.value
  }));

  const matches = await Person.find({
    _id: { $ne: id },
    $or: orConditions
  }).lean();

  const transformed = matches.map(p => {
    const matched_keys = [];
    for (const mk of p.search_keys || []) {
      if (person.search_keys.some(sk => sk.type === mk.type && sk.value === mk.value)) {
        matched_keys.push({ type: mk.type, value: mk.value });
      }
    }
    p.id = p._id;
    delete p._id;
    delete p.__v;
    p.matched_keys = matched_keys;
    return p;
  });

  ctx.body = { persons: transformed, count: transformed.length };
});

// DELETE /api/persons/:id
router.delete('/:id', async (ctx) => {
  const { id } = ctx.params;

  // Manually cascade: delete traits and sightings first
  const session = await mongoose.startSession();
  let person;
  try {
    await session.withTransaction(async () => {
      await Trait.deleteMany({ person_id: id }, { session });
      await Sighting.deleteMany({ person_id: id }, { session });
      person = await Person.findByIdAndDelete(id, { session });
    });

    if (!person) {
      ctx.status = 404;
      ctx.body = { error: 'Person not found' };
      return;
    }

    // Clean up FAISS index (non-blocking - MongoDB is already cleaned)
    try {
      const faiss = getFaissService();
      await faiss.removePerson(id);
      await faiss.save();
      logger.info('Removed person from FAISS index', { person_id: id });
    } catch (faissErr) {
      logger.warn('Failed to remove person from FAISS index', { person_id: id, error: faissErr.message });
    }

    logger.info('Person deleted', { person_id: id });
    ctx.status = 204;
  } finally {
    session.endSession();
  }
});

// GET /api/persons/:id/statistics
router.get('/:id/statistics', async (ctx) => {
  const { id } = ctx.params;

  const stats = await Person.getStatistics(id);
  if (!stats) {
    ctx.status = 404;
    ctx.body = { error: 'Person not found' };
    return;
  }

  ctx.body = stats;
});

// GET /api/persons/:id/sightings
router.get('/:id/sightings', async (ctx) => {
  const { id } = ctx.params;
  const { limit = 100, offset = 0, has_snapshot } = ctx.query;

  const filter = { person_id: id };
  if (has_snapshot === 'true') filter.snapshot_path = { $ne: null };

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

// GET /api/persons/:id/traits
router.get('/:id/traits', async (ctx) => {
  const { id } = ctx.params;
  const { limit = 100, offset = 0, trait_type } = ctx.query;

  const filter = { person_id: id };
  if (trait_type) {
    filter.trait_type = trait_type;
  }

  const traits = await Trait.find(filter)
    .sort({ created_at: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit));

  ctx.body = {
    traits: traits.map(t => t.toJSON()),
    count: traits.length,
    limit: parseInt(limit),
    offset: parseInt(offset)
  };
});

// GET /api/persons/:id/similar
router.get('/:id/similar', async (ctx) => {
  const { id } = ctx.params;
  const { limit = 10, threshold = 0.4 } = ctx.query;
  const parsedLimit = parseInt(limit);
  const parsedThreshold = parseFloat(threshold);

  const faceTraits = await Trait.find({ person_id: id, trait_type: 'face' }).lean();
  if (faceTraits.length === 0) {
    ctx.body = { similar_persons: [], count: 0 };
    return;
  }

  const best = faceTraits.reduce((a, b) => {
    if (a.quality_score != null && b.quality_score != null) return a.quality_score >= b.quality_score ? a : b;
    if (a.quality_score != null) return a;
    if (b.quality_score != null) return b;
    return (a.created_at || 0) >= (b.created_at || 0) ? a : b;
  });

  // best.embedding from .lean() is a BSON Binary. Its underlying ArrayBuffer may be a shared
  // pool buffer with a non-4-byte-aligned byteOffset, causing Float32Array to throw.
  // Use slice() to copy into a new ArrayBuffer starting at offset 0 (always aligned).
  const rawBuf = Buffer.isBuffer(best.embedding)
    ? best.embedding
    : Buffer.isBuffer(best.embedding?.buffer)
      ? best.embedding.buffer
      : Buffer.from(best.embedding);
  const embeddingArray = Array.from(new Float32Array(rawBuf.buffer.slice(rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength)));

  // Get this person's external_id for self-match filtering (FAISS uses external_id as name)
  const selfPerson = await Person.findById(id, { external_id: 1 }).lean();
  const selfExtId = selfPerson?.external_id || id;

  const faiss = getFaissService();
  const results = await faiss.searchSimilar(embeddingArray, parsedLimit * 3, parsedThreshold);

  const filtered = results.filter(r => r.name !== selfExtId && r.name !== id);

  const byPerson = new Map();
  for (const r of filtered) {
    const existing = byPerson.get(r.name);
    if (!existing || r.similarity > existing.similarity) {
      byPerson.set(r.name, r);
    }
  }

  const sorted = [...byPerson.values()].sort((a, b) => b.similarity - a.similarity).slice(0, parsedLimit);
  const personIds = sorted.map(r => r.name);

  // FAISS names are external_ids, so look up persons by external_id
  const persons = await Person.find({ external_id: { $in: personIds } }).lean();
  const personMap = new Map(persons.map(p => [p.external_id, p]));

  const similar_persons = sorted
    .map(r => {
      const p = personMap.get(r.name);
      if (!p) return null;
      p.id = p._id;
      delete p._id;
      delete p.__v;
      p.similarity = r.similarity;
      return p;
    })
    .filter(Boolean);

  ctx.body = {
    similar_persons,
    count: similar_persons.length
  };
});

// GET /api/persons/:id/image
router.get('/:id/image', async (ctx) => {
  const { id } = ctx.params;

  ctx.set('Cross-Origin-Resource-Policy', 'cross-origin');
  ctx.set('Access-Control-Allow-Origin', '*');

  const sighting = await Sighting.findOne({
    person_id: id,
    snapshot_path: { $ne: null }
  }).sort({ confidence_score: -1, detected_at: -1 });

  if (sighting && sighting.snapshot_path) {
    const snapshotPath = sighting.snapshot_path;

    if (snapshotPath.startsWith('data:image')) {
      const base64Data = snapshotPath.split(',')[1];
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const imageType = snapshotPath.match(/data:image\/(\w+);/)?.[1] || 'jpeg';
      ctx.type = `image/${imageType}`;
      ctx.body = imageBuffer;
      return;
    }
  }

  // Default placeholder image (1x1 gray pixel)
  ctx.type = 'image/png';
  ctx.body = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
});

// GET /api/persons/:id/face3d
router.get('/:id/face3d', async (ctx) => {
  const { id } = ctx.params;

  ctx.set('Cross-Origin-Resource-Policy', 'cross-origin');
  ctx.set('Access-Control-Allow-Origin', '*');

  const person = await Person.findById(id, 'face_model_3d face_model_format');
  if (!person) {
    ctx.status = 404;
    ctx.body = { error: 'Person not found' };
    return;
  }

  if (!person.face_model_3d) {
    ctx.status = 404;
    ctx.body = { error: 'No 3D face model available' };
    return;
  }

  ctx.type = person.face_model_format === 'glb' ? 'model/gltf-binary' : 'application/octet-stream';
  ctx.body = person.face_model_3d;
});

// PUT /api/persons/:id/face3d
const updateFace3dSchema = Joi.object({
  face_model_3d: Joi.string().required(),
  face_model_format: Joi.string().valid('glb', 'gltf').default('glb')
});

router.put('/:id/face3d', async (ctx) => {
  const { id } = ctx.params;
  const { error, value } = updateFace3dSchema.validate(ctx.request.body);

  if (error) {
    ctx.status = 400;
    ctx.body = { error: error.details[0].message };
    return;
  }

  const modelBuffer = Buffer.from(value.face_model_3d, 'base64');

  const person = await Person.findByIdAndUpdate(id, {
    $set: {
      face_model_3d: modelBuffer,
      face_model_format: value.face_model_format,
      face_model_updated_at: new Date()
    }
  }, { new: true, projection: '_id face_model_format face_model_updated_at' });

  if (!person) {
    ctx.status = 404;
    ctx.body = { error: 'Person not found' };
    return;
  }

  logger.info('Face 3D model updated', { person_id: id, format: value.face_model_format });

  ctx.body = {
    id: person._id,
    face_model_format: person.face_model_format,
    face_model_updated_at: person.face_model_updated_at
  };
});

// POST /api/persons/merge
const mergePersonsSchema = Joi.object({
  source_person_id: Joi.string().required(),
  target_person_id: Joi.string().required()
});

router.post('/merge', async (ctx) => {
  const { error, value } = mergePersonsSchema.validate(ctx.request.body);
  if (error) {
    ctx.status = 400;
    ctx.body = { error: error.details[0].message };
    return;
  }

  const { source_person_id, target_person_id } = value;

  if (source_person_id === target_person_id) {
    ctx.status = 400;
    ctx.body = { error: 'Cannot merge a person with itself' };
    return;
  }

  try {
    const result = await mergePersons(source_person_id, target_person_id);

    ctx.body = {
      success: true,
      target_person_id,
      traits_moved: result.traits_moved,
      sightings_moved: result.sightings_moved,
      message: `Successfully merged person ${source_person_id} into ${target_person_id}`
    };
  } catch (err) {
    if (err.message.includes('not found')) {
      ctx.status = 404;
      ctx.body = { error: err.message };
      return;
    }
    logger.error('Person merge failed', { error: err.message, source_person_id, target_person_id });
    throw err;
  }
});

export default router;
