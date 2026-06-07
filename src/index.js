import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import cors from 'koa-cors';
import helmet from 'koa-helmet';
import config from './config.js';
import logger from './logger.js';
import db from './database.js';
import { errorHandler } from './middleware/errorHandler.js';
import { apiKeyAuth } from './middleware/auth.js';

// Import models (registers schemas with mongoose)
import './models/index.js';

// Import routes
import healthRouter from './routes/health.js';
import personsRouter from './routes/persons.js';
import traitsRouter from './routes/traits.js';
import sightingsRouter from './routes/sightings.js';
import faissRouter from './routes/faiss.js';
import similarityRouter from './routes/similarity.js';
import osintAssetsRouter from './routes/osintAssets.js';

// Import services
import { getFaissService } from './services/faiss-service.js';
import { getSimilarityQueue } from './services/similarity-queue.js';
import { getSimilarityProcessor } from './services/similarity-processor.js';

const app = new Koa();

// Global error handler
app.on('error', (err) => {
  logger.error('Application error:', err);
});

// Middleware chain (order matters!)
app.use(errorHandler);
app.use(helmet());
app.use(cors());
app.use(bodyParser({
  jsonLimit: '10mb', // Allow larger payloads for embeddings
  textLimit: '10mb'
}));

// Request logging
app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  logger.info('Request', {
    method: ctx.method,
    path: ctx.path,
    status: ctx.status,
    duration: `${ms}ms`
  });
});

// Health check (no auth required)
app.use(healthRouter.routes()).use(healthRouter.allowedMethods());

// API routes (auth required)
app.use(apiKeyAuth);
app.use(personsRouter.routes()).use(personsRouter.allowedMethods());
app.use(traitsRouter.routes()).use(traitsRouter.allowedMethods());
app.use(sightingsRouter.routes()).use(sightingsRouter.allowedMethods());
app.use(faissRouter.routes()).use(faissRouter.allowedMethods());
app.use(similarityRouter.routes()).use(similarityRouter.allowedMethods());
app.use(osintAssetsRouter.routes()).use(osintAssetsRouter.allowedMethods());

// Root endpoint
app.use(async (ctx) => {
  if (ctx.path === '/') {
    ctx.body = {
      service: 'Person ReID Traits Database Handler',
      version: '1.0.0',
      status: 'running',
      endpoints: {
        health: '/health',
        persons: '/api/persons',
        traits: '/api/traits',
        sightings: '/api/sightings',
        faiss: '/api/faiss',
        similarity: '/api/similarity',
        osintAssets: '/api/osint-assets'
      }
    };
  }
});

// Initialize and start services
let faissService = null;
let similarityQueue = null;
let similarityProcessor = null;

async function startServices() {
  try {
    // Start FAISS service
    faissService = getFaissService();
    await faissService.start();
    logger.info('FAISS service initialized');
  } catch (error) {
    logger.error('Failed to start FAISS service:', error);
    logger.warn('Application will continue without FAISS support');
  }

  // Start similarity queue (sequential job processor)
  similarityQueue = getSimilarityQueue();
  similarityQueue.start();

  // Start similarity processor (10-min interval, jobs go through the queue)
  similarityProcessor = getSimilarityProcessor();
  similarityProcessor.start();
}

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down gracefully...');

  // Stop similarity processor + queue
  if (similarityProcessor) {
    similarityProcessor.stop();
  }
  if (similarityQueue) {
    similarityQueue.stop();
  }

  // Stop FAISS service
  if (faissService) {
    try {
      await faissService.stop();
      logger.info('FAISS service stopped');
    } catch (error) {
      logger.error('Error stopping FAISS service:', error);
    }
  }

  // Close database
  await db.close();

  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
const port = config.port;

async function start() {
  // Connect to MongoDB before starting the server
  await db.connect();

  const server = app.listen(port, async () => {
    logger.info(`Traits DB Handler API running on port ${port}`);
    logger.info(`Environment: ${config.env}`);

    // Initialize services
    await startServices();

    logger.info('Ready to handle requests');
  });

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(`Port ${port} in use, killing old process...`);
      const { execSync } = await import('child_process');
      try {
        execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' });
      } catch {}
      setTimeout(() => {
        app.listen(port, async () => {
          logger.info(`Traits DB Handler API running on port ${port}`);
          logger.info(`Environment: ${config.env}`);
          await startServices();
          logger.info('Ready to handle requests');
        });
      }, 2000);
    } else {
      throw err;
    }
  });
}

start().catch(err => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});

export default app;
