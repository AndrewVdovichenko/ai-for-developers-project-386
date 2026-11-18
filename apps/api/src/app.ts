import Fastify from 'fastify';
import pg from 'pg';
import { createEventType, getEventType, listEventTypes } from './event-types.js';
import { ownerSubject, readOperation } from './operations.js';
import { getAvailability, saveAvailability } from './availability.js';
import { checkSchema } from './migrations.js';
import { AccessError, login, logout, session } from './access.js';

export function createApp(options: {
  pool: pg.Pool;
  origin: string;
  now?: () => Date;
  trustProxy?: string[];
}) {
  const now = options.now ?? (() => new Date());
  const origin = new URL(options.origin);
  if (
    origin.origin !== options.origin ||
    (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:')
  )
    throw new Error('APP_ORIGIN должен содержать origin; production требует HTTPS');
  const secure = origin.protocol === 'https:';
  const cookieName = secure ? '__Host-owner_session' : 'owner_session';
  const cookie = (secret: string, maxAge: number) =>
    `${cookieName}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const secretFrom = (header?: string) =>
    header
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
  const app = Fastify({
    logger: {
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    trustProxy: options.trustProxy ?? false,
  });
  app.addHook('onReady', () => checkSchema(options.pool));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AccessError) {
      if (error.retryAfterSeconds !== undefined)
        reply.header('Retry-After', error.retryAfterSeconds);
      return reply.code(error.status).send({
        code: error.code,
        message: error.message,
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      });
    }
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Некорректный запрос' });
    const databaseError =
      error instanceof pg.DatabaseError ||
      (error instanceof Error &&
        /connection|pool|timeout|ECONN|EHOST|ENET|EPIPE|ENOTFOUND/i.test(error.message));
    return reply.code(databaseError ? 503 : 500).send({
      code: databaseError ? 'TEMPORARILY_UNAVAILABLE' : 'INTERNAL_ERROR',
      message: databaseError
        ? 'Сервис временно недоступен. Повторите попытку.'
        : 'Не удалось выполнить запрос. Повторите попытку.',
    });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers.origin !== options.origin
    ) {
      return reply
        .code(403)
        .send({ code: 'ORIGIN_NOT_ALLOWED', message: 'Источник запроса не подтверждён' });
    }
    if (
      request.url.split('?')[0] !== '/api/owner/session' &&
      request.url.startsWith('/api/owner/')
    ) {
      const current = await session(options.pool, secretFrom(request.headers.cookie), now);
      if (!current.authenticated)
        return reply
          .code(401)
          .send({ code: 'OWNER_AUTH_REQUIRED', message: 'Войдите в раздел Владельца' });
    }
  });
  app.get('/', async () => {
    await options.pool.query('SELECT 1');
    return { status: 'ok' };
  });
  app.get('/api/owner/session', (request) =>
    session(options.pool, secretFrom(request.headers.cookie), now),
  );
  app.post('/api/owner/session', async (request, reply) => {
    const body = request.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !('password' in body) ||
      typeof body.password !== 'string'
    )
      throw new AccessError(400, 'INVALID_REQUEST', 'Укажите пароль');
    const { secret, ...result } = await login(options.pool, body.password, request.ip, now);
    reply.header('Set-Cookie', cookie(secret, 604800));
    return result;
  });
  app.delete('/api/owner/session', async (request, reply) => {
    await logout(options.pool, secretFrom(request.headers.cookie));
    return reply.header('Set-Cookie', cookie('', 0)).code(204).send();
  });
  app.get('/api/event-types', () => listEventTypes(options.pool));
  app.get('/api/owner/availability', () => getAvailability(options.pool));
  app.put('/api/owner/availability', async (request, reply) => {
    const result = await saveAvailability(
      options.pool,
      request.headers['idempotency-key'],
      request.body,
    );
    return reply.code(result.status).send(result.body);
  });
  app.get<{ Params: { id: string } }>('/api/event-types/:id', async (request, reply) => {
    const result = await getEventType(options.pool, request.params.id);
    return (
      result ??
      reply.code(404).send({ code: 'EVENT_TYPE_NOT_FOUND', message: 'Тип встречи не найден' })
    );
  });
  app.post('/api/owner/event-types', async (request, reply) => {
    const result = await createEventType(
      options.pool,
      request.headers['idempotency-key'],
      request.body,
    );
    return reply.code(result.status).send(result.body);
  });
  app.get<{ Params: { key: string } }>('/api/owner/operations/:key', (request) =>
    readOperation(options.pool, ownerSubject, request.params.key),
  );
  return app;
}
