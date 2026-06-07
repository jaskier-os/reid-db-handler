/**
 * Similarity Progress API Routes
 * Stores progress data for external similarity workers (reid-worker)
 */

import Router from 'koa-router';
import Joi from 'joi';
import Trait from '../models/Trait.js';
import PersonRelationship from '../models/PersonRelationship.js';
import { getSimilarityProcessor } from '../services/similarity-processor.js';
import logger from '../logger.js';

const router = new Router({ prefix: '/api/similarity' });

// Validation schemas
const progressUpdateSchema = Joi.object({
  person_id: Joi.string().required(),
  compared_against: Joi.array().items(Joi.string()).required()
});

const progressBatchSchema = Joi.object({
  entries: Joi.array().items(progressUpdateSchema).min(1).required()
});

/**
 * GET /api/similarity/progress
 * Get similarity progress for all or specific persons
 */
router.get('/progress', async (ctx) => {
  const { person_id } = ctx.query;

  const query = { trait_type: 'face' };
  if (person_id) {
    query.person_id = person_id;
  }

  const traits = await Trait.find(query, {
    person_id: 1,
    similar_faces_processed: 1
  }).lean();

  const totalFaces = await Trait.countDocuments({ trait_type: 'face' });

  const progress = traits.map(t => {
    const processedSum = t.similar_faces_processed
      ? Object.values(t.similar_faces_processed).reduce((a, b) => a + b, 0)
      : 0;
    return {
      trait_id: t._id,
      person_id: t.person_id,
      processed: processedSum,
      total: totalFaces,
      complete: processedSum >= totalFaces - 1
    };
  });

  ctx.body = {
    total_faces: totalFaces,
    progress
  };
});

/**
 * GET /api/similarity/progress/:personId
 * Get similarity progress for a specific person
 */
router.get('/progress/:personId', async (ctx) => {
  const { personId } = ctx.params;

  const traits = await Trait.find(
    { trait_type: 'face', person_id: personId },
    { person_id: 1, similar_faces_processed: 1 }
  ).lean();

  if (!traits.length) {
    ctx.status = 404;
    ctx.body = { error: 'No face traits found for person' };
    return;
  }

  const totalFaces = await Trait.countDocuments({ trait_type: 'face' });

  const progress = traits.map(t => {
    const processedSum = t.similar_faces_processed
      ? Object.values(t.similar_faces_processed).reduce((a, b) => a + b, 0)
      : 0;
    return {
      trait_id: t._id,
      person_id: t.person_id,
      processed: processedSum,
      total: totalFaces,
      complete: processedSum >= totalFaces - 1
    };
  });

  ctx.body = { progress };
});

/**
 * PUT /api/similarity/progress/:personId
 * Update similarity progress for a person (called by reid-worker)
 */
router.put('/progress/:personId', async (ctx) => {
  const { personId } = ctx.params;
  const { compared_count } = ctx.request.body;

  if (compared_count === undefined) {
    ctx.status = 400;
    ctx.body = { error: 'compared_count required' };
    return;
  }

  const result = await Trait.updateMany(
    { trait_type: 'face', person_id: personId },
    { $set: { 'similar_faces_processed.worker': compared_count } }
  );

  ctx.body = {
    updated: result.modifiedCount,
    person_id: personId,
    compared_count
  };
});

/**
 * DELETE /api/similarity/progress
 * Reset all similarity progress (force full re-analysis)
 */
router.delete('/progress', async (ctx) => {
  const result = await Trait.updateMany(
    { trait_type: 'face' },
    { $set: { similar_faces_processed: {} } }
  );

  ctx.body = {
    reset: result.modifiedCount,
    message: 'All similarity progress reset'
  };
});

/**
 * DELETE /api/similarity/progress/:personId
 * Reset similarity progress for a specific person
 */
router.delete('/progress/:personId', async (ctx) => {
  const { personId } = ctx.params;

  const result = await Trait.updateMany(
    { trait_type: 'face', person_id: personId },
    { $set: { similar_faces_processed: {} } }
  );

  ctx.body = {
    reset: result.modifiedCount,
    person_id: personId
  };
});

/**
 * PUT /api/similarity/relationship
 * Upsert a similar_face relationship between two persons
 */
router.put('/relationship', async (ctx) => {
  const { person_a_id, person_b_id, similarity_score } = ctx.request.body;

  if (!person_a_id || !person_b_id || similarity_score === undefined) {
    ctx.status = 400;
    ctx.body = { error: 'person_a_id, person_b_id, and similarity_score required' };
    return;
  }

  const rel = await PersonRelationship.findOneAndUpdate(
    {
      person_a_id,
      person_b_id,
      relationship_type: 'similar_face'
    },
    { $max: { similarity_score } },
    { upsert: true, new: true }
  );

  ctx.body = rel.toJSON();
});

/**
 * GET /api/similarity/relationships/:personId
 * Get all similar_face relationships for a person
 */
router.get('/relationships/:personId', async (ctx) => {
  const { personId } = ctx.params;

  const rels = await PersonRelationship.find({
    $or: [{ person_a_id: personId }, { person_b_id: personId }],
    relationship_type: 'similar_face'
  }).sort({ similarity_score: -1 }).lean();

  ctx.body = { relationships: rels.map(r => ({ ...r, id: r._id, _id: undefined, __v: undefined })) };
});

/**
 * POST /api/similarity/recalc
 * Trigger full similarity recalculation (resets all progress, reprocesses every face)
 */
router.post('/recalc', async (ctx) => {
  const processor = getSimilarityProcessor();

  if (processor.recalcRunning) {
    ctx.status = 409;
    ctx.body = { error: 'Full recalculation already in progress' };
    return;
  }

  processor.recalcRunning = true;
  // Run in background so the HTTP request returns immediately
  processor.fullRecalc()
    .then(result => {
      logger.info('Full recalc finished', result);
    })
    .catch(err => {
      logger.error('Full recalc failed', { error: err.message });
    })
    .finally(() => {
      processor.recalcRunning = false;
    });

  ctx.body = { message: 'Full recalculation started' };
});

export default router;
