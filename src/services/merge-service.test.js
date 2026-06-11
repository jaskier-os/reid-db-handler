import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// config.js validates these at import time, so set them before any
// config-dependent module is imported. All such imports below are dynamic.
process.env.API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

let mongod;
let mongoose;
let Person;
let Face3DFrames;
let Trait;
let Sighting;
let mergePersons;

before(async () => {
  // mergePersons uses session.withTransaction, which requires a replica set.
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongod.getUri();

  mongoose = (await import('mongoose')).default;
  await mongoose.connect(mongod.getUri());

  ({ Person, Face3DFrames, Trait, Sighting } = await import('../models/index.js'));
  ({ mergePersons } = await import('./merge-service.js'));
});

after(async () => {
  if (mongoose) await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function makePerson(extId, extra = {}) {
  return Person.create({ external_id: extId, ...extra });
}

test('source has frames + target none: target inherits frames doc, flagged, model cleared', async () => {
  const source = await makePerson('ext-src-a', { face_model_3d: Buffer.from([1, 2, 3]) });
  const target = await makePerson('ext-tgt-a', {
    face_model_3d: Buffer.from([9, 9, 9]),
    face_model_updated_at: new Date()
  });

  await Face3DFrames.create({
    person_id: source._id,
    frame_count: 42,
    last_built_at_count: 30,
    frames: Buffer.from([0xde, 0xad])
  });

  await mergePersons(source._id, target._id);

  const srcDoc = await Face3DFrames.findOne({ person_id: source._id });
  const tgtDoc = await Face3DFrames.findOne({ person_id: target._id });
  assert.equal(srcDoc, null, 'source frames doc reassigned away');
  assert.ok(tgtDoc, 'target now owns a frames doc');
  assert.equal(tgtDoc.frame_count, 42, 'reassigned source frames preserved');
  assert.equal(tgtDoc.last_built_at_count, 0, 'rebuild flagged');

  const tgtPerson = await Person.findById(target._id);
  assert.equal(tgtPerson.face_model_3d, null, 'stale built model cleared');
  assert.equal(tgtPerson.face_model_format, 'glb');
  assert.equal(tgtPerson.face_model_updated_at, null);
});

test('both have frames: target doc kept and flagged, source doc deleted', async () => {
  const source = await makePerson('ext-src-b');
  const target = await makePerson('ext-tgt-b', { face_model_3d: Buffer.from([7]) });

  await Face3DFrames.create({
    person_id: source._id, frame_count: 11, last_built_at_count: 5,
    frames: Buffer.from([0x01])
  });
  await Face3DFrames.create({
    person_id: target._id, frame_count: 80, last_built_at_count: 70,
    frames: Buffer.from([0x02])
  });

  await mergePersons(source._id, target._id);

  const srcDoc = await Face3DFrames.findOne({ person_id: source._id });
  const tgtDoc = await Face3DFrames.findOne({ person_id: target._id });
  assert.equal(srcDoc, null, 'source frames doc deleted');
  assert.ok(tgtDoc, 'target frames doc kept');
  assert.equal(tgtDoc.frame_count, 80, 'target frames kept (not merged)');
  assert.equal(tgtDoc.last_built_at_count, 0, 'rebuild flagged');

  const tgtPerson = await Person.findById(target._id);
  assert.equal(tgtPerson.face_model_3d, null, 'stale built model cleared');
});

test('no source frames: target face_model_3d NOT cleared', async () => {
  const source = await makePerson('ext-src-c');
  const builtModel = Buffer.from([5, 5, 5]);
  const target = await makePerson('ext-tgt-c', { face_model_3d: builtModel });

  // Target may or may not have its own frames; either way, no source frames
  // means no reconciliation, so the target's built model must be left intact.
  await Face3DFrames.create({
    person_id: target._id, frame_count: 20, last_built_at_count: 18,
    frames: Buffer.from([0x03])
  });

  await mergePersons(source._id, target._id);

  const tgtPerson = await Person.findById(target._id);
  assert.ok(tgtPerson.face_model_3d, 'built model preserved when no source frames');
  assert.deepEqual(Buffer.from(tgtPerson.face_model_3d), builtModel);

  const tgtDoc = await Face3DFrames.findOne({ person_id: target._id });
  assert.equal(tgtDoc.last_built_at_count, 18, 'target frames untouched');
});

test('traits and sightings still move on merge', async () => {
  const source = await makePerson('ext-src-d');
  const target = await makePerson('ext-tgt-d');

  await Trait.create({ person_id: source._id, trait_type: 'face', embedding: Buffer.from([0x01]) });
  await Sighting.create({
    person_id: source._id, camera_id: 'cam1', detected_at: new Date(), confidence_score: 0.9
  });

  const res = await mergePersons(source._id, target._id);
  assert.equal(res.traits_moved, 1);
  assert.equal(res.sightings_moved, 1);
  assert.equal(await Person.findById(source._id), null, 'source person deleted');
});
