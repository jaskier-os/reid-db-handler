import mongoose from 'mongoose';
import { Person, Trait, Sighting, PersonRelationship } from '../models/index.js';
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

  try {
    await session.withTransaction(async () => {
      const [source, target] = await Promise.all([
        Person.findById(sourcePersonId).session(session),
        Person.findById(targetPersonId).session(session)
      ]);

      if (!source) throw new Error(`Source person not found: ${sourcePersonId}`);
      if (!target) throw new Error(`Target person not found: ${targetPersonId}`);

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

      await Person.findByIdAndDelete(sourcePersonId, { session });

      targetPerson = await Person.findByIdAndUpdate(
        targetPersonId,
        { $set: { last_seen_at: new Date() } },
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

  // FAISS: relabel source entries to target (non-fatal)
  try {
    const faiss = getFaissService();
    if (faiss.isReady) {
      await faiss.renamePerson(sourcePersonId, targetPersonId);
      await faiss.save();
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
