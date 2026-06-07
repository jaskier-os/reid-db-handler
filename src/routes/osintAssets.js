import Router from 'koa-router';
import Joi from 'joi';
import { OsintAsset } from '../models/index.js';
import logger from '../logger.js';

const router = new Router({ prefix: '/api/osint-assets' });

const createAssetSchema = Joi.object({
  filename: Joi.string().required(),
  content_type: Joi.string().required(),
  asset_type: Joi.string().valid('photo', 'report').required(),
  person_id: Joi.string().optional().allow(null),
  source: Joi.string().optional().allow(null),
  data: Joi.string().required() // base64
});

// POST /api/osint-assets
router.post('/', async (ctx) => {
  const { error, value } = createAssetSchema.validate(ctx.request.body);
  if (error) {
    ctx.status = 400;
    ctx.body = { error: error.details[0].message };
    return;
  }

  const dataBuffer = Buffer.from(value.data, 'base64');

  // Upsert by filename - if same filename exists, update data
  const asset = await OsintAsset.findOneAndUpdate(
    { filename: value.filename },
    {
      filename: value.filename,
      content_type: value.content_type,
      asset_type: value.asset_type,
      person_id: value.person_id || null,
      source: value.source || null,
      data: dataBuffer
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  logger.info('OSINT asset saved', {
    id: asset._id,
    filename: value.filename,
    asset_type: value.asset_type,
    size: dataBuffer.length
  });

  ctx.status = 201;
  ctx.body = { id: asset._id, filename: asset.filename };
});

// GET /api/osint-assets/by-filename/:filename
router.get('/by-filename/:filename', async (ctx) => {
  const { filename } = ctx.params;

  const asset = await OsintAsset.findOne({ filename });
  if (!asset) {
    ctx.status = 404;
    ctx.body = { error: 'Asset not found' };
    return;
  }

  ctx.set('Content-Type', asset.content_type);
  ctx.set('Cache-Control', 'public, max-age=86400');
  ctx.body = asset.data;
});

// GET /api/osint-assets/:id
router.get('/:id', async (ctx) => {
  const { id } = ctx.params;

  const asset = await OsintAsset.findById(id);
  if (!asset) {
    ctx.status = 404;
    ctx.body = { error: 'Asset not found' };
    return;
  }

  ctx.set('Content-Type', asset.content_type);
  ctx.set('Cache-Control', 'public, max-age=86400');
  ctx.body = asset.data;
});

// DELETE /api/osint-assets/:id
router.delete('/:id', async (ctx) => {
  const { id } = ctx.params;

  const asset = await OsintAsset.findByIdAndDelete(id);
  if (!asset) {
    ctx.status = 404;
    ctx.body = { error: 'Asset not found' };
    return;
  }

  logger.info('OSINT asset deleted', { id });
  ctx.status = 204;
});

export default router;
