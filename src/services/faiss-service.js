/**
 * FAISS Face Database Service
 * Manages centralized FAISS index for face recognition
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class FaissService {
    constructor() {
        this.pythonProcess = null;
        this.requestCounter = 0;
        this.pendingRequests = new Map();
        this.isReady = false;
        this.pythonScript = path.join(__dirname, '../../faiss_server.py');
        const venvPython = path.join(__dirname, '../../venv/bin/python');
        this.pythonBin = existsSync(venvPython) ? venvPython : 'python3';
        this.dbPath = path.join(__dirname, '../../database/faiss');
    }

    /**
     * Start the FAISS Python service
     */
    async start() {
        try {
            // Ensure database directory exists
            await fs.mkdir(this.dbPath, { recursive: true });

            logger.info('Starting FAISS service...');

            // Spawn Python process for FAISS operations
            this.pythonProcess = spawn(this.pythonBin, [this.pythonScript, this.dbPath], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            // Handle stdout (responses from Python)
            this.pythonProcess.stdout.on('data', (data) => {
                const lines = data.toString().split('\n').filter(line => line.trim());

                for (const line of lines) {
                    try {
                        const response = JSON.parse(line);
                        this._handleResponse(response);
                    } catch (err) {
                        logger.debug(`FAISS stdout: ${line}`);
                    }
                }
            });

            // Handle stderr
            this.pythonProcess.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg.includes('ERROR') || msg.includes('Traceback') || msg.includes('Exception')) {
                    logger.error(`FAISS: ${msg}`);
                } else {
                    logger.info(`FAISS: ${msg}`);
                }
            });

            // Handle process exit
            this.pythonProcess.on('exit', (code) => {
                logger.warn(`FAISS process exited with code ${code}`);
                this.isReady = false;

                // Reject all pending requests
                for (const [id, { reject }] of this.pendingRequests) {
                    reject(new Error('FAISS service crashed'));
                }
                this.pendingRequests.clear();
            });

            // Wait for ready signal
            await this._waitForReady();

            logger.info('FAISS service started successfully');
        } catch (error) {
            logger.error('Failed to start FAISS service:', error);
            throw error;
        }
    }

    /**
     * Wait for FAISS service to be ready
     */
    _waitForReady() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('FAISS service timeout'));
            }, 30000);

            const checkReady = setInterval(() => {
                if (this.isReady) {
                    clearTimeout(timeout);
                    clearInterval(checkReady);
                    resolve();
                }
            }, 100);
        });
    }

    /**
     * Handle response from Python process
     */
    _handleResponse(response) {
        if (response.type === 'ready') {
            this.isReady = true;
            logger.info(`FAISS loaded with ${response.count} faces`);
            return;
        }

        const { request_id, result, error } = response;
        const pending = this.pendingRequests.get(request_id);

        if (!pending) {
            logger.warn(`Received response for unknown request: ${request_id}`);
            return;
        }

        this.pendingRequests.delete(request_id);

        if (error) {
            pending.reject(new Error(error));
        } else {
            pending.resolve(result);
        }
    }

    /**
     * Send request to Python FAISS process
     */
    _sendRequest(method, params = {}) {
        if (!this.isReady) {
            return Promise.reject(new Error('FAISS service not ready'));
        }

        const requestId = ++this.requestCounter;
        const request = {
            request_id: requestId,
            method,
            params
        };

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { resolve, reject });

            // Send request to Python
            const requestStr = JSON.stringify(request) + '\n';
            this.pythonProcess.stdin.write(requestStr);

            // Timeout after 30 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Request timeout'));
                }
            }, 30000);
        });
    }

    /**
     * Search for a face in the database
     * @param {Array<number>} embedding - Face embedding vector (512 dimensions)
     * @param {number} threshold - Similarity threshold (default 0.4)
     * @returns {Promise<{name: string, similarity: number}>}
     */
    async search(embedding, threshold = 0.4) {
        if (!Array.isArray(embedding) || embedding.length !== 512) {
            throw new Error('Invalid embedding: must be array of 512 numbers');
        }

        const result = await this._sendRequest('search', { embedding, threshold });
        return result;
    }

    /**
     * Batch search for multiple faces
     * @param {Array<Array<number>>} embeddings - Array of face embeddings
     * @param {number} threshold - Similarity threshold
     * @returns {Promise<Array<{name: string, similarity: number}>>}
     */
    async batchSearch(embeddings, threshold = 0.4) {
        if (!Array.isArray(embeddings) || embeddings.length === 0) {
            throw new Error('Invalid embeddings: must be non-empty array');
        }

        const result = await this._sendRequest('batch_search', { embeddings, threshold });
        return result;
    }

    /**
     * Add a face to the database
     * @param {Array<number>} embedding - Face embedding vector
     * @param {string} name - Person identifier/name
     * @returns {Promise<{success: boolean}>}
     */
    async addFace(embedding, name) {
        if (!Array.isArray(embedding) || embedding.length !== 512) {
            throw new Error('Invalid embedding: must be array of 512 numbers');
        }

        if (!name || typeof name !== 'string') {
            throw new Error('Invalid name: must be non-empty string');
        }

        const result = await this._sendRequest('add_face', { embedding, name });
        return result;
    }

    /**
     * Add multiple faces to the database
     * @param {Array<Array<number>>} embeddings - Array of face embeddings
     * @param {Array<string>} names - Array of person identifiers
     * @returns {Promise<{success: boolean, count: number}>}
     */
    async addFacesBatch(embeddings, names) {
        if (!Array.isArray(embeddings) || !Array.isArray(names)) {
            throw new Error('embeddings and names must be arrays');
        }

        if (embeddings.length !== names.length) {
            throw new Error('embeddings and names must have same length');
        }

        const result = await this._sendRequest('add_faces_batch', { embeddings, names });
        return result;
    }

    /**
     * Search for top-K similar faces in the database
     * @param {Array<number>} embedding - Face embedding vector (512 dimensions)
     * @param {number} k - Number of results to return
     * @param {number} threshold - Similarity threshold (default 0.4)
     * @returns {Promise<Array<{name: string, similarity: number}>>}
     */
    async searchSimilar(embedding, k = 10, threshold = 0.4) {
        if (!Array.isArray(embedding) || embedding.length !== 512) {
            throw new Error('Invalid embedding: must be array of 512 numbers');
        }

        return this._sendRequest('search_similar', { embedding, k, threshold });
    }

    /**
     * Rename all entries for a person (used after merge)
     * @param {string} oldName - Person ID to rename from
     * @param {string} newName - Person ID to rename to
     * @returns {Promise<{success: boolean, renamed: number}>}
     */
    async renamePerson(oldName, newName) {
        return this._sendRequest('rename_person', { old_name: oldName, new_name: newName });
    }

    /**
     * Remove all entries for a person and rebuild index
     * @param {string} name - Person ID to remove
     * @returns {Promise<{success: boolean, removed: number, total: number}>}
     */
    async removePerson(name) {
        return this._sendRequest('remove_person', { name });
    }

    /**
     * Save FAISS index to disk
     * @returns {Promise<{success: boolean}>}
     */
    async save() {
        const result = await this._sendRequest('save');
        return result;
    }

    /**
     * Get database statistics
     * @returns {Promise<{total_faces: number, metadata: Array}>}
     */
    async getStats() {
        const result = await this._sendRequest('get_stats');
        return result;
    }

    /**
     * Stop the FAISS service
     */
    async stop() {
        if (!this.pythonProcess) {
            return;
        }

        logger.info('Stopping FAISS service...');

        // Request save before shutdown
        try {
            await this.save();
        } catch (error) {
            logger.error('Failed to save FAISS on shutdown:', error);
        }

        // Send shutdown signal
        try {
            await this._sendRequest('shutdown');
        } catch (error) {
            // Ignore errors during shutdown
        }

        // Kill process if still alive
        setTimeout(() => {
            if (this.pythonProcess && !this.pythonProcess.killed) {
                this.pythonProcess.kill();
            }
        }, 2000);

        this.isReady = false;
        logger.info('FAISS service stopped');
    }
}

// Singleton instance
let faissServiceInstance = null;

/**
 * Get or create FAISS service instance
 */
export function getFaissService() {
    if (!faissServiceInstance) {
        faissServiceInstance = new FaissService();
    }
    return faissServiceInstance;
}

export default FaissService;
