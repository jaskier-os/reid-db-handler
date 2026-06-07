import mongoose from 'mongoose';
import config from './config.js';
import logger from './logger.js';

class Database {
  async connect() {
    const maxRetries = 30;
    const retryDelayMs = 2000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await mongoose.connect(config.mongodbUri, {
          serverSelectionTimeoutMS: 5000,
          connectTimeoutMS: 5000
        });

        mongoose.connection.on('error', (err) => {
          logger.error('MongoDB connection error:', err);
        });

        mongoose.connection.on('disconnected', () => {
          logger.warn('MongoDB disconnected');
        });

        logger.info('Connected to MongoDB');
        return;
      } catch (error) {
        if (attempt === maxRetries) {
          logger.error('Failed to connect to MongoDB after all retries:', error);
          throw error;
        }
        logger.warn(`MongoDB not ready, retrying in ${retryDelayMs / 1000}s (attempt ${attempt}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  async close() {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
  }

  async healthCheck() {
    try {
      const state = mongoose.connection.readyState;
      if (state !== 1) {
        return { healthy: false, error: 'Not connected' };
      }
      await mongoose.connection.db.admin().ping();
      return { healthy: true, timestamp: new Date() };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }
}

const db = new Database();

export default db;
