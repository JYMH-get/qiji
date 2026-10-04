import type { FastifyInstance } from 'fastify';

/** Liveness stays available; business requests wait for recovery to finish. */
export function registerStartupReadiness(app: FastifyInstance) {
  let state: 'starting' | 'ready' | 'failed' | 'stopping' = 'starting';
  app.get('/ready', async (_request, reply) => reply.code(state === 'ready' ? 200 : 503).send({ready:state === 'ready',state}));
  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0];
    if (state !== 'ready' && pathname !== '/health' && pathname !== '/ready') {
      return reply.code(503).header('Retry-After','3').send({error:'服务正在准备，请稍后重试'});
    }
  });
  return {
    ready:() => { if (state === 'starting') state='ready'; },
    failed:() => { if (state !== 'stopping') state='failed'; },
    stopping:() => { state='stopping'; },
  };
}
