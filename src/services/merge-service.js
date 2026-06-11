import mongoose from 'mongoose';
import { Person, Trait, Sighting, PersonRelationship, Face3DFrames } from '../models/index.js';
import { getFaissService } from './faiss-service.js';
import config from '../config.js';
import logger from '../logger.js';

/**
 * Merge source person into target person.
 * Moves all traits + sightings, deletes source, cleans up FAISS + relationships.
 * Fires webhook if configured.
 *
 * @param {string} sourcePersonId
 * @param {string} targetPersonId
 * @returns {{ traits_moved: number, sightings_moved: number, target_person: object }}
 */
export async function mergePersons(sourcePersonId, targetPersonId) {
  if (sourcePersonId === targetPersonId) {
    throw new Error('Cannot merge a person with itself');
  }

  const session = await mongoose.startSession();
  let traitsMoved = 0;
  let sightingsMoved = 0;
  let targetPerson;
  let sourceExternalId = null;
  let targetExternalId = null;

  try {
    await session.withTransaction(async () => {
      const [source, target] = await Promise.all([
        Person.findById(sourcePersonId).session(session),
        Person.findById(targetPersonId).session(session)
      ]);

      if (!source) throw new Error(`Source person not found: ${sourcePersonId}`);
      if (!target) throw new Error(`Target person not found: ${targetPersonId}`);

      // FAISS is keyed by Person.external_id (not DB id). Capture both before the
      // source is deleted so we can relabel FAISS entries after the transaction.
      sourceExternalId = source.external_id;
      targetExternalId = target.external_id;

      const traitsResult = await Trait.updateMany(
        { person_id: sourcePersonId },
        { $set: { person_id: targetPersonId } },
        { session }
      );
      traitsMoved = traitsResult.modifiedCount;

      const sightingsResult = await Sighting.updateMany(
        { person_id: sourcePersonId },
        { $set: { person_id: targetPersonId } },
        { session }
      );
      sightingsMoved = sightingsResult.modifiedCount;

      await PersonRelationship.deleteMany({
        $or: [
          { person_a_id: sourcePersonId },
          { person_b_id: sourcePersonId }
        ]
      }, { session });

      // Reconcile per-person 3D face frames. db-handler must NEVER decode or
      // re-pack the frames blob (the worker owns packing), so we never merge the
      // two blobs here. last_built_at_count = 0 is the rebuild signal: the
      // worker's next cadence check (frame_count - last_built_at_count >=
      // refine_interval) fires a rebuild once it rehydrates the target's frames.
      const [srcF3, tgtF3] = await Promise.all([
        Face3DFrames.findOne({ person_id: sourcePersonId }).session(session),
        Face3DFrames.findOne({ person_id: targetPersonId }).session(session)
      ]);

      const framesReconciled = !!srcF3;

      if (srcF3 && !tgtF3) {
        // Target has no frames doc: reassign the source's doc to the target.
        // person_id has a unique index; safe because the target has no doc.
        await Face3DFrames.updateOne(
          { person_id: sourcePersonId },
          { $set: { person_id: targetPersonId, last_built_at_count: 0 } },
          { session }
        );
      } else if (srcF3 && tgtF3) {
        // Both have frames docs. We cannot merge the two blobs (the worker owns
        // packing and db-handler must never decode it), so we keep the target's
        // frames and just flag it for rebuild. This discards the source's
        // accumulated frames, which is acceptable: the worker re-accumulates.
        await Face3DFrames.updateOne(
          { person_id: targetPersonId },
          { $set: { last_built_at_count: 0 } },
          { session }
        );
        await Face3DFrames.deleteOne({ person_id: sourcePersonId }, { session });
      }

      await Person.findByIdAndDelete(sourcePersonId, { session });

      // When frames were reconciled the target is now flagged for rebuild, so
      // any previously built model is stale: clear it so an outdated GLB does
      // not linger until the worker rebuilds.
      const targetUpdate = { last_seen_at: new Date() };
      if (framesReconciled) {
        targetUpdate.face_model_3d = null;
        targetUpdate.face_model_format = 'glb';
        targetUpdate.face_model_updated_at = null;
      }

      targetPerson = await Person.findByIdAndUpdate(
        targetPersonId,
        { $set: targetUpdate },
        { session, new: true }
      );
    });
  } finally {
    session.endSession();
  }

  logger.info('Persons merged', {
    source_person_id: sourcePersonId,
    target_person_id: targetPersonId,
    traits_moved: traitsMoved,
    sightings_moved: sightingsMoved
  });

  // FAISS: relabel source entries to target (non-fatal). FAISS is keyed by
  // Person.external_id, so the rename must operate on external_ids, not DB ids.
  try {
    const faiss = getFaissService();
    if (faiss.isReady) {
      if (sourceExternalId && targetExternalId) {
        await faiss.renamePerson(sourceExternalId, targetExternalId);
        await faiss.save();
      } else {
        logger.warn('Skipping FAISS rename after merge: missing external_id', {
          source_external_id: sourceExternalId,
          target_external_id: targetExternalId
        });
      }
    }
  } catch (err) {
    logger.warn('FAISS cleanup after merge failed (non-fatal)', { error: err.message });
  }

  // Webhook notification (fire-and-forget)
  if (config.mergeWebhookUrl) {
    fireWebhook(sourcePersonId, targetPersonId, targetPerson).catch(err => {
      logger.warn('Merge webhook failed', { error: err.message });
    });
  }

  return {
    traits_moved: traitsMoved,
    sightings_moved: sightingsMoved,
    target_person: targetPerson?.toJSON?.() ?? targetPerson
  };
}

async function fireWebhook(sourcePersonId, targetPersonId, targetPerson) {
  const payload = {
    event: 'person_merged',
    source_person_id: sourcePersonId,
    target_person_id: targetPersonId,
    target_display_name: targetPerson?.display_name ?? null,
    timestamp: new Date().toISOString()
  };

  const resp = await fetch(config.mergeWebhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000)
  });

  if (!resp.ok) {
    throw new Error(`Webhook returned ${resp.status}`);
  }
}
