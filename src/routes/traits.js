import Router from 'koa-router';
import Joi from 'joi';
import mongoose from 'mongoose';
import { Trait } from '../models/index.js';
import { queueAutoMergeCheck } from '../services/auto-merge.js';
import logger from '../logger.js';

const router = new Router({ prefix: '/api/traits' });

const createTraitSchema = Joi.object({
  person_id: Joi.string().required(),
  trait_type: Joi.string().valid('face', 'gait', 'voice', 'iris').required(),
  embedding: Joi.string().required(),
  embedding_dimension: Joi.number().integer().required(),
  model_name: Joi.string().optional(),
  model_version: Joi.string().optional(),
  quality_score: Joi.number().min(0).max(1).optional(),
  source_camera_id: Joi.string().optional(),
  source_timestamp: Joi.date().iso().optional(),
  source_metadata: Joi.object().optional(),
  liveness_score: Joi.number().min(0).max(1).optional(),
  liveness_passed: Joi.boolean().optional()
});

// GET /api/traits
router.get('/', async (ctx) => {
  const { person_id, trait_type, limit = 100, offset = 0 } = ctx.query;

  const filter = {};
  if (person_id) filter.person_id = person_id;
  if (trait_type) filter.trait_type = trait_type;

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

// GET /api/traits/:id
router.get('/:id', async (ctx) => {
  const { id } = ctx.params;

  const trait = await Trait.findById(id);
  if (!trait) {
    ctx.status = 404;
    ctx.body = { error: 'Trait not found' };
    return;
  }

  ctx.body = trait.toJSON();
});

// POST /api/traits
router.post('/', async (ctx) => {
  const { error, value } = createTraitSchema.validate(ctx.request.body);
  if (error) {
    ctx.status = 400;
    ctx.body = { error: error.details[0].message };
    return;
  }

  const embeddingBuffer = Buffer.from(value.embedding, 'base64');

  const trait = await Trait.create({
    person_id: value.person_id,
    trait_type: value.trait_type,
    embedding: embeddingBuffer,
    embedding_dimension: value.embedding_dimension,
    model_name: value.model_name || null,
    model_version: value.model_version || null,
    quality_score: value.quality_score ?? null,
    source_camera_id: value.source_camera_id || null,
    source_timestamp: value.source_timestamp || null,
    source_metadata: value.source_metadata || {},
    liveness_score: value.liveness_score ?? null,
    liveness_passed: value.liveness_passed ?? null
  });

  logger.info('Trait created', {
    trait_id: trait._id,
    person_id: value.person_id,
    trait_type: value.trait_type
  });

  // Queue auto-merge check in background (non-blocking)
  queueAutoMergeCheck(trait);

  ctx.status = 201;
  ctx.body = trait.toJSON();
});

// POST /api/traits/batch
router.post('/batch', async (ctx) => {
  const { traits } = ctx.request.body;

  if (!Array.isArray(traits) || traits.length === 0) {
    ctx.status = 400;
    ctx.body = { error: 'traits must be a non-empty array' };
    return;
  }

  for (const trait of traits) {
    const { error } = createTraitSchema.validate(trait);
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
      const docs = traits.map(t => ({
        person_id: t.person_id,
        trait_type: t.trait_type,
        embedding: Buffer.from(t.embedding, 'base64'),
        embedding_dimension: t.embedding_dimension,
        model_name: t.model_name || null,
        model_version: t.model_version || null,
        quality_score: t.quality_score ?? null,
        source_camera_id: t.source_camera_id || null,
        source_timestamp: t.source_timestamp || null,
        source_metadata: t.source_metadata || {},
        liveness_score: t.liveness_score ?? null,
        liveness_passed: t.liveness_passed ?? null
      }));

      created = await Trait.insertMany(docs, { session });
    });

    logger.info('Batch traits created', { count: created.length });

    for (const t of created) {
      queueAutoMergeCheck(t);
    }

    ctx.status = 201;
    ctx.body = {
      created: created.length,
      traits: created.map(t => t.toJSON())
    };
  } finally {
    session.endSession();
  }
});

// DELETE /api/traits/:id
router.delete('/:id', async (ctx) => {
  const { id } = ctx.params;

  const trait = await Trait.findByIdAndDelete(id);
  if (!trait) {
    ctx.status = 404;
    ctx.body = { error: 'Trait not found' };
    return;
  }

  logger.info('Trait deleted', { trait_id: id });
  ctx.status = 204;
});

export default router;
