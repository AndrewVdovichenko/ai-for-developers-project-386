import Fastify from 'fastify';
export function createApp() {
  const app = Fastify({ logger: true });
  app.get('/', async () => ({ status: 'ok' }));
  return app;
}
