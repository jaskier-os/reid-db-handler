import { Trait, Person } from '../models/index.js';
import { mergePersons } from './merge-service.js';
import { getSimilarityQueue } from './similarity-queue.js';
import config from '../config.js';
import logger from '../logger.js';

// Guard against concurrent merges of the same person
const activeMerges = new Set();

/**
 * Queue an auto-merge check for a newly created face trait.
 * Non-blocking -- returns immediately, work happens in the background queue.
 *
 * @param {{ person_id: string, embedding: Buffer, trait_type: string }} trait
 */
export function queueAutoMergeCheck(trait) {
  if (!config.autoMergeEnabled) return;
  if (trait.trait_type !== 'face') return;
  if (!trait.embedding) return;

  const queue = getSimilarityQueue();
  queue.enqueue({
    type: 'auto_merge_check',
    label: `person=${trait.person_id}`,
    handler: () => runAutoMergeCheck(trait.person_id, trait.embedding)
  });
}

/**
 * Compare embedding against the best embedding of every other person.
 * If similarity >= threshold, merge the two persons.
 */
async function runAutoMergeCheck(personId, embeddingBuffer) {
  if (activeMerges.has(personId)) {
    logger.debug('auto-merge: skipped (already merging)', { personId });
    return;
  }

  // Verify the person still exists (may have been merged already)
  const person = await Person.findById(personId);
  if (!person) {
    logger.debug('auto-merge: person no longer exists', { personId });
    return;
  }

  // Get best face trait per other person (highest quality, most recent as tiebreaker)
  const bestTraits = await Trait.aggregate([
    { $match: { trait_type: 'face', person_id: { $ne: personId }, embedding: { $exists: true } } },
    { $sort: { quality_score: -1, created_at: -1 } },
    { $group: {
      _id: '$person_id',
      embedding: { $first: '$embedding' },
      quality_score: { $first: '$quality_score' }
    }}
  ]);

  if (bestTraits.length === 0) return;

  // Prepare source embedding
  const srcEmb = toFloat32(embeddingBuffer);
  normalize(srcEmb);

  // Find best match
  let bestMatch = null;
  for (const bt of bestTraits) {
    if (!bt.embedding) continue;
    const otherEmb = toFloat32(bt.embedding.buffer ?? bt.embedding);
    normalize(otherEmb);
    const sim = dot(srcEmb, otherEmb);

    if (sim >= config.autoMergeThreshold && (!bestMatch || sim > bestMatch.similarity)) {
      bestMatch = { person_id: bt._id, similarity: sim };
    }
  }

  if (!bestMatch) return;

  // Determine source (to be deleted) and target (to be kept)
  // New/smaller person is always source
  const otherPerson = await Person.findById(bestMatch.person_id);
  if (!otherPerson) return;

  const [myTraitCount, otherTraitCount] = await Promise.all([
    Trait.countDocuments({ person_id: personId }),
    Trait.countDocuments({ person_id: bestMatch.person_id })
  ]);

  let sourceId, targetId;
  if (myTraitCount <= otherTraitCount) {
    sourceId = personId;
    targetId = bestMatch.person_id;
  } else {
    sourceId = bestMatch.person_id;
    targetId = personId;
  }

  // Prefer keeping the person with a display_name
  const srcPerson = sourceId === personId ? person : otherPerson;
  const tgtPerson = sourceId === personId ? otherPerson : person;
  if (srcPerson.display_name && !tgtPerson.display_name) {
    // Swap -- keep the one with a name
    [sourceId, targetId] = [targetId, sourceId];
  }

  activeMerges.add(sourceId);
  try {
    logger.info('auto-merge: merging persons', {
      source: sourceId,
      target: targetId,
      similarity: bestMatch.similarity.toFixed(4)
    });

    const result = await mergePersons(sourceId, targetId);
    logger.info('auto-merge: complete', {
      source: sourceId,
      target: targetId,
      traits_moved: result.traits_moved
    });
  } finally {
    activeMerges.delete(sourceId);
  }
}

// ---- Embedding math helpers ----

function toFloat32(buf) {
  if (buf instanceof Float32Array) return new Float32Array(buf);
  const b = buf instanceof Buffer ? buf : Buffer.from(buf);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

function normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
}

function dot(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}
