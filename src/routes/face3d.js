import Router from 'koa-router';
import Joi from 'joi';
import zlib from 'zlib';
import { Face3DFrames } from '../models/index.js';
import { readFloat16 } from '../utils/float16.js';
import logger from '../logger.js';

const router = new Router({ prefix: '/api/persons' });

// Packing constants (see docs/plans/2026-06-11-face3d-persistence-design.md).
const HEADER_BYTES = 5;        // magic(2) + schema_version(1) + record_count(2)
const EMBEDDING_BYTES = 512 * 2; // 512 x float16
const PARAMS_BYTES = 257 * 2;    // 257 x float16
const SUPPORTED_SCHEMA_VERSIONS = new Set([1]);

const putFramesSchema = Joi.object({
  frame_count: Joi.number().integer().min(0).required(),
  last_built_at_count: Joi.number().integer().min(0).required(),
  schema_version: Joi.number().integer().min(1).required(),
  frames_b64: Joi.string().allow(null).required()
});

// GET /api/persons/:id/face3d-frames
router.get('/:id/face3d-frames', async (ctx) => {
  const { id } = ctx.params;

  const doc = await Face3DFrames.findOne({ person_id: id });
  if (!doc) {
    ctx.status = 404;
    ctx.body = { error: 'No face3d frames' };
    return;
  }

  ctx.body = {
    person_id: doc.person_id,
    frame_count: doc.frame_count,
    last_built_at_count: doc.last_built_at_count,
    schema_version: doc.schema_version,
    frames_b64: doc.frames ? doc.frames.toString('base64') : null
  };
});

// PUT /api/persons/:id/face3d-frames
router.put('/:id/face3d-frames', async (ctx) => {
  const { id } = ctx.params;
  const { error, value } = putFramesSchema.validate(ctx.request.body);
  if (error) {
    ctx.status = 400;
    ctx.body = { error: error.details[0].message };
    return;
  }

  let framesBuffer = null;
  if (value.frames_b64 !== null) {
    framesBuffer = Buffer.from(value.frames_b64, 'base64');
  }

  const doc = await Face3DFrames.findOneAndUpdate(
    { person_id: id },
    {
      $set: {
        person_id: id,
        frame_count: value.frame_count,
        last_built_at_count: value.last_built_at_count,
        schema_version: value.schema_version,
        frames: framesBuffer
      }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  logger.info('Face3D frames stored', {
    person_id: id,
    frame_count: doc.frame_count,
    schema_version: doc.schema_version
  });

  ctx.body = {
    person_id: doc.person_id,
    frame_count: doc.frame_count,
    last_built_at_count: doc.last_built_at_count,
    schema_version: doc.schema_version,
    updated_at: doc.updated_at
  };
});

// GET /api/persons/:id/face3d-frames/summary
router.get('/:id/face3d-frames/summary', async (ctx) => {
  const { id } = ctx.params;

  const doc = await Face3DFrames.findOne({ person_id: id });
  if (!doc) {
    ctx.status = 404;
    ctx.body = { error: 'No face3d frames' };
    return;
  }

  if (!doc.frames) {
    ctx.body = {
      frame_count: doc.frame_count,
      last_built_at_count: doc.last_built_at_count,
      schema_version: doc.schema_version,
      record_count: 0,
      yaw_bins: {},
      null_pose_count: 0,
      avg_quality: null
    };
    return;
  }

  if (!SUPPORTED_SCHEMA_VERSIONS.has(doc.schema_version)) {
    ctx.body = { error: 'undecodable', schema_version: doc.schema_version };
    return;
  }

  try {
    const blob = zlib.inflateSync(doc.frames);

    if (blob.length < HEADER_BYTES) {
      ctx.body = { error: 'undecodable', schema_version: doc.schema_version };
      return;
    }

    const blobSchemaVersion = blob.readUInt8(2);
    if (!SUPPORTED_SCHEMA_VERSIONS.has(blobSchemaVersion)) {
      ctx.body = { error: 'undecodable', schema_version: blobSchemaVersion };
      return;
    }

    const recordCount = blob.readUInt16LE(3);

    const yawBins = {};
    let nullPoseCount = 0;
    let qualitySum = 0;
    let qualityCount = 0;

    let off = HEADER_BYTES;
    for (let i = 0; i < recordCount; i++) {
      // yaw(2) pitch(2) roll(2) quality(2) timestamp(4) camera_len(1) camera(N) emb(1024) params(514)
      const yaw = readFloat16(blob, off);
      const quality = readFloat16(blob, off + 6);
      const cameraLen = blob.readUInt8(off + 12);
      off += 13 + cameraLen + EMBEDDING_BYTES + PARAMS_BYTES;

      if (Number.isNaN(yaw)) {
        nullPoseCount += 1;
      } else {
        const bin = Math.floor(yaw / 30);
        yawBins[bin] = (yawBins[bin] || 0) + 1;
      }

      if (!Number.isNaN(quality)) {
        qualitySum += quality;
        qualityCount += 1;
      }
    }

    ctx.body = {
      frame_count: doc.frame_count,
      last_built_at_count: doc.last_built_at_count,
      schema_version: doc.schema_version,
      record_count: recordCount,
      yaw_bins: yawBins,
      null_pose_count: nullPoseCount,
      avg_quality: qualityCount > 0 ? qualitySum / qualityCount : null
    };
  } catch (err) {
    logger.warn('Face3D frames summary decode failed', { person_id: id, error: err.message });
    ctx.body = { error: 'undecodable', schema_version: doc.schema_version };
  }
});

export default router;
