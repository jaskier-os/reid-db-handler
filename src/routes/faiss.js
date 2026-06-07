/**
 * FAISS Face Database API Routes
 */

import Router from 'koa-router';
import Joi from 'joi';
import { getFaissService } from '../services/faiss-service.js';
import logger from '../logger.js';

const router = new Router({ prefix: '/api/faiss' });

// Validation schemas
const embeddingSchema = Joi.array().items(Joi.number()).length(512).required();

const searchSchema = Joi.object({
    embedding: embeddingSchema,
    threshold: Joi.number().min(0).max(1).default(0.4)
});

const batchSearchSchema = Joi.object({
    embeddings: Joi.array().items(embeddingSchema).min(1).required(),
    threshold: Joi.number().min(0).max(1).default(0.4)
});

const addFaceSchema = Joi.object({
    embedding: embeddingSchema,
    name: Joi.string().required()
});

const addFacesBatchSchema = Joi.object({
    embeddings: Joi.array().items(embeddingSchema).min(1).required(),
    names: Joi.array().items(Joi.string()).min(1).required()
}).custom((value, helpers) => {
    if (value.embeddings.length !== value.names.length) {
        return helpers.error('any.invalid', {
            message: 'embeddings and names arrays must have the same length'
        });
    }
    return value;
});

/**
 * POST /api/faiss/search
 * Search for a single face
 */
router.post('/search', async (ctx) => {
    const { error, value } = searchSchema.validate(ctx.request.body);

    if (error) {
        ctx.status = 400;
        ctx.body = { error: error.details[0].message };
        return;
    }

    try {
        const faiss = getFaissService();
        const result = await faiss.search(value.embedding, value.threshold);

        ctx.body = result;
    } catch (err) {
        logger.error('FAISS search failed:', err);
        ctx.status = 500;
        ctx.body = { error: 'Search failed', details: err.message };
    }
});

/**
 * POST /api/faiss/search/batch
 * Batch search for multiple faces
 */
router.post('/search/batch', async (ctx) => {
    const { error, value } = batchSearchSchema.validate(ctx.request.body);

    if (error) {
        ctx.status = 400;
        ctx.body = { error: error.details[0].message };
        return;
    }

    try {
        const faiss = getFaissService();
        const results = await faiss.batchSearch(value.embeddings, value.threshold);

        ctx.body = {
            results,
            count: results.length
        };
    } catch (err) {
        logger.error('FAISS batch search failed:', err);
        ctx.status = 500;
        ctx.body = { error: 'Batch search failed', details: err.message };
    }
});

/**
 * POST /api/faiss/add
 * Add a single face to the database
 */
router.post('/add', async (ctx) => {
    const { error, value } = addFaceSchema.validate(ctx.request.body);

    if (error) {
        ctx.status = 400;
        ctx.body = { error: error.details[0].message };
        return;
    }

    try {
        const faiss = getFaissService();
        const result = await faiss.addFace(value.embedding, value.name);

        ctx.body = result;
        logger.info(`Added face for person: ${value.name}`);
    } catch (err) {
        logger.error('FAISS add face failed:', err);
        ctx.status = 500;
        ctx.body = { error: 'Add face failed', details: err.message };
    }
});

/**
 * POST /api/faiss/add/batch
 * Add multiple faces to the database
 */
router.post('/add/batch', async (ctx) => {
    const { error, value } = addFacesBatchSchema.validate(ctx.request.body);

    if (error) {
        ctx.status = 400;
        ctx.body = { error: error.details[0].message };
        return;
    }

    try {
        const faiss = getFaissService();
        const result = await faiss.addFacesBatch(value.embeddings, value.names);

        ctx.body = result;
        logger.info(`Added ${value.embeddings.length} faces in batch`);
    } catch (err) {
        logger.error('FAISS batch add failed:', err);
        ctx.status = 500;
        ctx.body = { error: 'Batch add failed', details: err.message };
    }
});

/**
 * POST /api/faiss/save
 * Save FAISS index to disk
 */
router.post('/save', async (ctx) => {
    try {
        const faiss = getFaissService();
        const result = await faiss.save();

        ctx.body = result;
        logger.info('FAISS database saved');
    } catch (err) {
        logger.error('FAISS save failed:', err);
        ctx.status = 500;
        ctx.body = { error: 'Save failed', details: err.message };
    }
});

/**
 * GET /api/faiss/stats
 * Get FAISS database statistics
 */
router.get('/stats', async (ctx) => {
    try {
        const faiss = getFaissService();
        const stats = await faiss.getStats();

        ctx.body = stats;
    } catch (err) {
        logger.error('FAISS stats failed:', err);
        ctx.status = 500;
        ctx.body = { error: 'Failed to get stats', details: err.message };
    }
});

// PUT /api/faiss/person/:name/rename
router.put('/person/:name/rename', async (ctx) => {
    const { name } = ctx.params;
    const { new_name } = ctx.request.body || {};

    if (!new_name) {
        ctx.status = 400;
        ctx.body = { error: 'new_name is required' };
        return;
    }

    try {
        const faiss = getFaissService();
        const result = await faiss.renamePerson(name, new_name);
        await faiss.save();
        ctx.body = result;
    } catch (err) {
        logger.error('FAISS rename failed:', err);
        ctx.status = 500;
        ctx.body = { error: 'Failed to rename person', details: err.message };
    }
});

// DELETE /api/faiss/person/:name
router.delete('/person/:name', async (ctx) => {
    const { name } = ctx.params;

    try {
        const faiss = getFaissService();
        const result = await faiss.removePerson(name);
        await faiss.save();
        ctx.body = result;
    } catch (err) {
        logger.error('FAISS remove failed:', err);
        ctx.status = 500;
        ctx.body = { error: 'Failed to remove person', details: err.message };
    }
});

export default router;
