import Router from 'koa-router';
import db from '../database.js';

const router = new Router({ prefix: '/health' });

router.get('/', async (ctx) => {
  const dbHealth = await db.healthCheck();

  ctx.body = {
    status: dbHealth.healthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    database: dbHealth
  };

  ctx.status = dbHealth.healthy ? 200 : 503;
});

export default router;
