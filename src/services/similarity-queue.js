import logger from '../logger.js';

/**
 * Single sequential queue for ALL similarity and merge work.
 * Guarantees: one job at a time, no parallel execution,
 * no blind retries, no stalling of HTTP responses.
 *
 * Job types:
 *  - 'auto_merge_check': triggered after trait creation (non-blocking)
 *  - 'similarity_sweep': triggered by 10-min interval
 */
class SimilarityQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.stopped = false;
  }

  /**
   * Add a job to the queue. Non-blocking -- returns immediately.
   * @param {{ type: string, handler: () => Promise<void>, label: string }} job
   */
  enqueue(job) {
    if (this.stopped) {
      logger.debug('SimilarityQueue: dropped job (stopped)', { type: job.type, label: job.label });
      return;
    }
    this.queue.push(job);
    if (this.queue.length > 50) {
      logger.warn('SimilarityQueue: queue growing large', { queueSize: this.queue.length });
    } else {
      logger.debug('SimilarityQueue: enqueued', { type: job.type, label: job.label, queueSize: this.queue.length });
    }
    this._drain();
  }

  /**
   * Process jobs one at a time. If already processing, does nothing
   * (the current run will pick up new items when it finishes).
   */
  async _drain() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0 && !this.stopped) {
      const job = this.queue.shift();
      try {
        logger.info('SimilarityQueue: processing', { type: job.type, label: job.label, remaining: this.queue.length });
        await job.handler();
        logger.info('SimilarityQueue: completed', { type: job.type, label: job.label });
      } catch (err) {
        // Log and move on -- no retry
        logger.error('SimilarityQueue: job failed', {
          type: job.type,
          label: job.label,
          error: err.message
        });
      }
    }

    this.processing = false;
  }

  /** Number of pending jobs */
  get size() {
    return this.queue.length;
  }

  /** Whether a job is currently executing */
  get busy() {
    return this.processing;
  }

  stop() {
    this.stopped = true;
    this.queue = [];
    logger.info('SimilarityQueue: stopped');
  }

  start() {
    this.stopped = false;
    logger.info('SimilarityQueue: started');
  }
}

// Singleton
let instance = null;

export function getSimilarityQueue() {
  if (!instance) {
    instance = new SimilarityQueue();
  }
  return instance;
}

export default SimilarityQueue;
