import config from '../config.js';
import logger from '../logger.js';

export async function apiKeyAuth(ctx, next) {
  const apiKey = ctx.get('x-api-key') || ctx.get('Authorization')?.replace('Bearer ', '');

  if (!apiKey || apiKey !== config.apiKey) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    logger.warn('Unauthorized API request', { path: ctx.path, ip: ctx.ip });
    return;
  }

  await next();
}
