import dotenv from 'dotenv';
import Joi from 'joi';

dotenv.config();

const configSchema = Joi.object({
  PORT: Joi.number().default(3001),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),

  MONGODB_URI: Joi.string().required(),

  API_KEY: Joi.string().required(),
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  SIMILARITY_MAX_WORKERS: Joi.number().integer().min(1).max(20).default(5),
  AUTO_MERGE_ENABLED: Joi.boolean().default(true),
  AUTO_MERGE_THRESHOLD: Joi.number().min(0.4).max(1.0).default(0.6),
  MERGE_WEBHOOK_URL: Joi.string().uri().optional().allow('').default('')
}).unknown();

const { error, value: config } = configSchema.validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

export default {
  port: config.PORT,
  env: config.NODE_ENV,

  mongodbUri: config.MONGODB_URI,

  apiKey: config.API_KEY,
  logLevel: config.LOG_LEVEL,
  similarityMaxWorkers: config.SIMILARITY_MAX_WORKERS,
  autoMergeEnabled: config.AUTO_MERGE_ENABLED,
  autoMergeThreshold: config.AUTO_MERGE_THRESHOLD,
  mergeWebhookUrl: config.MERGE_WEBHOOK_URL || ''
};
