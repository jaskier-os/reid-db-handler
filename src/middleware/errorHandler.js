import logger from '../logger.js';

export async function errorHandler(ctx, next) {
  try {
    await next();
  } catch (err) {
    ctx.status = err.status || 500;

    ctx.body = {
      error: err.message || 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    };

    logger.error('Request error:', {
      method: ctx.method,
      path: ctx.path,
      status: ctx.status,
      error: err.message,
      stack: err.stack
    });
  }
}
