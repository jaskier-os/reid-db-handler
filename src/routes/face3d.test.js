import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { writeFloat16 } from '../utils/float16.test.js';

// config.js validates these at import time, so they must be set before any
// config-dependent module is imported. All such imports below are dynamic.
process.env.API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const API_KEY = 'test-key';

let mongod;
let mongoose;
let Face3DFrames;
let server;
let baseUrl;

before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();

  mongoose = (await import('mongoose')).default;
  await mongoose.connect(mongod.getUri());

  ({ default: Face3DFrames } = await import('../models/Face3DFrames.js'));
  const Koa = (await import('koa')).default;
  const bodyParser = (await import('koa-bodyparser')).default;
  const { apiKeyAuth } = await import('../middleware/auth.js');
  const face3dRouter = (await import('./face3d.js')).default;

  const app = new Koa();
  app.use(bodyParser({ jsonLimit: '10mb' }));
  app.use(apiKeyAuth);
  app.use(face3dRouter.routes()).use(face3dRouter.allowedMethods());

  server = app.listen(0);
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) server.close();
  if (mongoose) await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

function req(method, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-api-key': API_KEY,
      'content-type': 'application/json'
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}

// Build a compressed blob matching the worker packing format.
// Header: magic(2) + schema_version(1) + record_count(2 uint16 LE).
// Record: yaw(f16) pitch(f16) roll(f16) quality(f16) ts(uint32 LE)
//         camera_len(uint8) camera(utf8) embedding(512xf16) params(257xf16).
function buildBlob(records, schemaVersion = 1) {
  const header = Buffer.alloc(5);
  header.writeUInt8(0x33, 0); // magic byte 0
  header.writeUInt8(0x44, 1); // magic byte 1
  header.writeUInt8(schemaVersion, 2);
  header.writeUInt16LE(records.length, 3);

  const parts = [header];
  for (const r of records) {
    const camera = Buffer.from(r.camera, 'utf8');
    const fixed = Buffer.alloc(13);
    writeFloat16(r.yaw).copy(fixed, 0);
    writeFloat16(r.pitch ?? 0).copy(fixed, 2);
    writeFloat16(r.roll ?? 0).copy(fixed, 4);
    writeFloat16(r.quality).copy(fixed, 6);
    fixed.writeUInt32LE(r.ts ?? 0, 8);
    fixed.writeUInt8(camera.length, 12);

    const embedding = Buffer.alloc(512 * 2); // zeros, content irrelevant to summary
    const params = Buffer.alloc(257 * 2);
    parts.push(fixed, camera, embedding, params);
  }

  return zlib.deflateSync(Buffer.concat(parts));
}

test('PUT then GET round-trips counts and frames', async () => {
  const personId = 'person-roundtrip';
  const blob = buildBlob([
    { yaw: 0.5, quality: 0.9, camera: 'identify_api' }
  ]);
  const framesB64 = blob.toString('base64');

  const putRes = await req('PUT', `/api/persons/${personId}/face3d-frames`, {
    frame_count: 17,
    last_built_at_count: 0,
    schema_version: 1,
    frames_b64: framesB64
  });
  assert.equal(putRes.status, 200);
  const putBody = await putRes.json();
  assert.equal(putBody.frame_count, 17);
  assert.equal(putBody.last_built_at_count, 0);
  assert.equal(putBody.schema_version, 1);
  assert.ok(putBody.updated_at);
  assert.equal(putBody.frames_b64, undefined, 'PUT must not echo heavy buffer');

  const getRes = await req('GET', `/api/persons/${personId}/face3d-frames`);
  assert.equal(getRes.status, 200);
  const getBody = await getRes.json();
  assert.equal(getBody.person_id, personId);
  assert.equal(getBody.frame_count, 17);
  assert.equal(getBody.last_built_at_count, 0);
  assert.equal(getBody.schema_version, 1);
  assert.equal(getBody.frames_b64, framesB64);
});

test('PUT upserts (second PUT updates same doc)', async () => {
  const personId = 'person-upsert';
  await req('PUT', `/api/persons/${personId}/face3d-frames`, {
    frame_count: 10, last_built_at_count: 0, schema_version: 1,
    frames_b64: buildBlob([{ yaw: 0, quality: 0.5, camera: 'a' }]).toString('base64')
  });
  await req('PUT', `/api/persons/${personId}/face3d-frames`, {
    frame_count: 60, last_built_at_count: 50, schema_version: 1,
    frames_b64: buildBlob([{ yaw: 0, quality: 0.5, camera: 'a' }]).toString('base64')
  });

  const count = await Face3DFrames.countDocuments({ person_id: personId });
  assert.equal(count, 1);

  const getBody = await (await req('GET', `/api/persons/${personId}/face3d-frames`)).json();
  assert.equal(getBody.frame_count, 60);
  assert.equal(getBody.last_built_at_count, 50);
});

test('GET 404 when no frames stored', async () => {
  const res = await req('GET', '/api/persons/no-such-person/face3d-frames');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'No face3d frames');
});

test('PUT rejects malformed body with 400', async () => {
  const res = await req('PUT', '/api/persons/bad-body/face3d-frames', {
    frame_count: 'not-a-number',
    last_built_at_count: 0,
    schema_version: 1,
    frames_b64: null
  });
  assert.equal(res.status, 400);
});

test('summary returns yaw histogram, null_pose_count, avg_quality', async () => {
  const personId = 'person-summary';
  // yaw 5 -> bin 0, yaw 35 -> bin 1, yaw NaN -> null pose.
  const records = [
    { yaw: 5, quality: 0.8, camera: 'identify_api' },
    { yaw: 35, quality: 0.6, camera: 'stream:cam1' },
    { yaw: NaN, quality: 0.4, camera: 'x' }
  ];
  const blob = buildBlob(records);

  await req('PUT', `/api/persons/${personId}/face3d-frames`, {
    frame_count: 3, last_built_at_count: 0, schema_version: 1,
    frames_b64: blob.toString('base64')
  });

  const res = await req('GET', `/api/persons/${personId}/face3d-frames/summary`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.record_count, 3);
  assert.equal(body.null_pose_count, 1);
  assert.deepEqual(body.yaw_bins, { 0: 1, 1: 1 });
  // avg over the 3 decodable qualities (float16 of 0.8/0.6/0.4).
  assert.ok(Math.abs(body.avg_quality - (0.8 + 0.6 + 0.4) / 3) < 0.01);
  assert.equal(body.frame_count, 3);
});

test('summary 404 when no doc', async () => {
  const res = await req('GET', '/api/persons/missing/face3d-frames/summary');
  assert.equal(res.status, 404);
});

test('summary returns undecodable for unknown schema_version', async () => {
  const personId = 'person-badschema';
  await req('PUT', `/api/persons/${personId}/face3d-frames`, {
    frame_count: 1, last_built_at_count: 0, schema_version: 99,
    frames_b64: buildBlob([{ yaw: 0, quality: 0.5, camera: 'a' }], 99).toString('base64')
  });

  const res = await req('GET', `/api/persons/${personId}/face3d-frames/summary`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.error, 'undecodable');
  assert.equal(body.schema_version, 99);
});

test('summary returns undecodable for corrupt blob', async () => {
  const personId = 'person-corrupt';
  await req('PUT', `/api/persons/${personId}/face3d-frames`, {
    frame_count: 1, last_built_at_count: 0, schema_version: 1,
    frames_b64: Buffer.from('not zlib data at all').toString('base64')
  });

  const res = await req('GET', `/api/persons/${personId}/face3d-frames/summary`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.error, 'undecodable');
});
