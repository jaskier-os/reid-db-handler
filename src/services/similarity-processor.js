import config from '../config.js';
import logger from '../logger.js';
import Trait from '../models/Trait.js';
import Person from '../models/Person.js';
import PersonRelationship from '../models/PersonRelationship.js';
import { getSimilarityQueue } from './similarity-queue.js';
import { mergePersons } from './merge-service.js';

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

class SimilarityProcessor {
  constructor() {
    this.maxWorkers = config.similarityMaxWorkers;
    this.intervalId = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    logger.info('SimilarityProcessor started', { maxWorkers: this.maxWorkers });

    // Initial check on startup (queued)
    this.enqueueSweep();

    this.intervalId = setInterval(() => {
      this.enqueueSweep();
    }, CHECK_INTERVAL_MS);
  }

  stop() {
    this.stopped = true;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('SimilarityProcessor stopped');
  }

  /**
   * Enqueue a similarity sweep into the shared queue.
   * The queue ensures only one job runs at a time.
   */
  enqueueSweep() {
    const queue = getSimilarityQueue();
    queue.enqueue({
      type: 'similarity_sweep',
      label: 'periodic-check',
      handler: () => this.checkIncomplete()
    });
  }

  async checkIncomplete() {
    const totalFaces = await Trait.countDocuments({ trait_type: 'face' });
    if (totalFaces <= 1) {
      return;
    }

    const allFaceTraits = await Trait.find(
      { trait_type: 'face' },
      { _id: 1, person_id: 1, similar_faces_processed: 1 }
    ).lean();

    // Count faces per person for expected calculations
    const facesPerPerson = {};
    for (const t of allFaceTraits) {
      facesPerPerson[t.person_id] = (facesPerPerson[t.person_id] || 0) + 1;
    }

    for (const trait of allFaceTraits) {
      if (this.stopped) return;

      const samePersonFaceCount = facesPerPerson[trait.person_id] || 0;
      const expectedCount = totalFaces - samePersonFaceCount;
      if (expectedCount <= 0) continue;

      const processedSum = trait.similar_faces_processed
        ? Object.values(trait.similar_faces_processed).reduce((a, b) => a + b, 0)
        : 0;

      if (processedSum < expectedCount) {
        const exists = await Person.exists({ _id: trait.person_id });
        if (!exists) continue;

        const fullTrait = await Trait.findById(trait._id);
        if (!fullTrait) continue;

        await this.processFace(fullTrait);
      }
    }
  }

  /**
   * Full recalculation: reset all progress, clear relationships, reprocess every face.
   */
  async fullRecalc() {
    logger.info('SimilarityProcessor: starting full recalculation');

    // Clear all similar_face relationships
    const relResult = await PersonRelationship.deleteMany({ relationship_type: 'similar_face' });
    logger.info('SimilarityProcessor: cleared relationships', { deleted: relResult.deletedCount });

    // Reset all progress tracking
    await Trait.updateMany(
      { trait_type: 'face' },
      { $set: { similar_faces_processed: {} } }
    );

    // Process every face trait whose person still exists
    const allFaceTraits = await Trait.find({ trait_type: 'face' });
    const existingPersonIds = new Set(
      (await Person.find({}, { _id: 1 }).lean()).map(p => p._id)
    );
    const validTraits = allFaceTraits.filter(t => existingPersonIds.has(t.person_id));
    logger.info('SimilarityProcessor: processing faces', { total: allFaceTraits.length, valid: validTraits.length });

    let processed = 0;
    for (const trait of validTraits) {
      if (this.stopped) {
        logger.info('SimilarityProcessor: full recalc stopped early', { processed });
        return { processed, total: validTraits.length, stopped: true };
      }

      // Re-check person exists (may have been merged during this loop)
      const exists = await Person.exists({ _id: trait.person_id });
      if (!exists) continue;

      await this.processFace(trait);
      processed++;
      logger.info('SimilarityProcessor: full recalc progress', { processed, total: validTraits.length });
    }

    logger.info('SimilarityProcessor: full recalculation complete', { processed, total: validTraits.length });
    return { processed, total: validTraits.length, stopped: false };
  }

  async processFace(trait) {
    logger.info('SimilarityProcessor: processing face', { traitId: trait._id, personId: trait.person_id });

    const totalFaces = await Trait.countDocuments({
      trait_type: 'face',
      person_id: { $ne: trait.person_id }
    });

    if (totalFaces === 0) {
      logger.info('SimilarityProcessor: no other faces to compare against');
      return;
    }

    const numWorkers = Math.min(this.maxWorkers, totalFaces);
    const chunkSize = Math.ceil(totalFaces / numWorkers);

    // Reset progress
    await Trait.updateOne({ _id: trait._id }, { $set: { similar_faces_processed: {} } });

    // Launch workers (parallel within this single queued job is fine --
    // they only read traits and write relationships, no merge conflicts)
    const workerPromises = [];
    for (let i = 1; i <= numWorkers; i++) {
      workerPromises.push(this.runWorker(trait, i, chunkSize));
    }

    const results = await Promise.allSettled(workerPromises);

    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error('SimilarityProcessor: worker failed', { error: result.reason?.message });
      }
    }

    logger.info('SimilarityProcessor: face processing complete', { traitId: trait._id });
  }

  async runWorker(sourceTrait, workerIndex, chunkSize) {
    const buf = sourceTrait.embedding;
    const sourceEmbedding = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    normalize(sourceEmbedding);

    const cursor = Trait.find({
      trait_type: 'face',
      person_id: { $ne: sourceTrait.person_id }
    }).sort({ _id: 1 }).skip((workerIndex - 1) * chunkSize).limit(chunkSize).cursor();

    let count = 0;

    for await (const otherTrait of cursor) {
      if (this.stopped) break;

      const otherBuf = otherTrait.embedding;
      if (!otherBuf) {
        count++;
        continue;
      }

      const otherEmbedding = new Float32Array(otherBuf.buffer.slice(otherBuf.byteOffset, otherBuf.byteOffset + otherBuf.byteLength));
      normalize(otherEmbedding);

      const similarity = cosineSimilarity(sourceEmbedding, otherEmbedding);

      if (similarity >= 0.4) {
        await PersonRelationship.findOneAndUpdate(
          {
            person_a_id: sourceTrait.person_id,
            person_b_id: otherTrait.person_id,
            relationship_type: 'similar_face'
          },
          { $max: { similarity_score: similarity } },
          { upsert: true }
        );

        // Auto-merge if above threshold
        if (config.autoMergeEnabled && similarity >= config.autoMergeThreshold) {
          try {
            logger.info('SimilarityProcessor: auto-merging high-similarity pair', {
              personA: sourceTrait.person_id,
              personB: otherTrait.person_id,
              similarity: similarity.toFixed(4)
            });
            await mergePersons(sourceTrait.person_id, otherTrait.person_id);
            // Source was merged away, stop processing this trait
            return;
          } catch (err) {
            // If source person was already merged/deleted, stop processing this trait
            if (err.message.includes('Source person not found')) {
              logger.info('SimilarityProcessor: source person already merged, skipping remaining', { personId: sourceTrait.person_id });
              return;
            }
            logger.warn('SimilarityProcessor: auto-merge failed', { error: err.message });
          }
        }
      }

      count++;
      if (count % 100 === 0) {
        await this.reportProgress(sourceTrait._id, workerIndex, count);
      }
    }

    await this.reportProgress(sourceTrait._id, workerIndex, count);
    logger.debug('SimilarityProcessor: worker done', { workerIndex, count });
  }

  async reportProgress(traitId, workerIndex, count) {
    await Trait.updateOne(
      { _id: traitId },
      { $set: { [`similar_faces_processed.${workerIndex}`]: count } }
    );
  }
}

function normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= norm;
    }
  }
}

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

// Singleton
let instance = null;

export function getSimilarityProcessor() {
  if (!instance) {
    instance = new SimilarityProcessor();
  }
  return instance;
}

export default SimilarityProcessor;
