// Apple Container integration check. Uses only its own random container and volume.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  ownerSessionGetOwnerSession,
  ownerSessionLoginOwner,
  ownerSessionLogoutOwner,
  getStatus,
} from '@calendar/api-client';
import { createPool } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { resetPassword } from '../src/access.js';

async function container(...args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('container', args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`container ${args[0]} failed`)),
    );
  });
}
async function freePort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}
const port = await freePort();
const name = `calendar-test-${randomUUID()}`;
const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
const origin = 'http://localhost:5173';
const password = 'пароль тестового календаря'; // betterleaks:allow -- public test fixture
let pool = createPool(url);
let api: ChildProcess | undefined;
async function startApi() {
  const apiPort = await freePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  api = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../src/server.ts', import.meta.url))],
    {
      stdio: 'ignore',
      env: {
        ...process.env,
        DATABASE_URL: url,
        APP_ORIGIN: origin,
        HOST: '127.0.0.1',
        PORT: String(apiPort),
        TRUSTED_PROXIES: '127.0.0.1',
      },
    },
  );
  const deadline = Date.now() + 15_000;
  for (;;) {
    const status = await getStatus({ baseUrl });
    if (status.data) return baseUrl;
    if (api.exitCode !== null || Date.now() >= deadline) throw new Error('API not ready');
    await setTimeout(100);
  }
}
async function stopApi() {
  if (!api || api.exitCode !== null) return;
  const processToStop = api;
  await new Promise<void>((resolve, reject) => {
    processToStop.once('exit', () => resolve());
    processToStop.once('error', reject);
    processToStop.kill('SIGTERM');
  });
}
async function start() {
  await container(
    'run',
    '-d',
    '--name',
    name,
    '-p',
    `127.0.0.1:${port}:5432`,
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-v',
    `${name}:/var/lib/postgresql`,
    'postgres:18.7@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc',
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch {
      if (Date.now() >= deadline) throw new Error('PostgreSQL not ready');
      await setTimeout(100);
    }
  }
}
async function recreate() {
  await stopApi();
  await pool.end();
  await container('stop', name);
  await container('delete', name);
  pool = createPool(url);
  await start();
  return startApi();
}
try {
  await container('volume', 'create', name);
  await start();
  await migrate(pool);
  await resetPassword(pool, password, password);
  let baseUrl = await startApi();
  let ip = '203.0.113.1';
  const login = (value: string) =>
    ownerSessionLoginOwner({
      baseUrl,
      body: { password: value },
      headers: { Origin: origin, 'X-Forwarded-For': ip },
    });
  const cookie = (response: Response | undefined) =>
    response!.headers.get('set-cookie')!.split(';')[0]!;
  const active = await login(password);
  const activeCookie = cookie(active.response);
  const revokedCookie = cookie((await login(password)).response);
  await ownerSessionLogoutOwner({ baseUrl, headers: { Origin: origin, Cookie: revokedCookie } });
  for (let i = 0; i < 5; i++) assert.equal((await login('неверный')).response!.status, 401);
  baseUrl = await recreate();
  const status = (Cookie: string) => ownerSessionGetOwnerSession({ baseUrl, headers: { Cookie } });
  assert.equal((await status(activeCookie)).data?.expiresAt, active.data!.expiresAt);
  assert.equal((await status(revokedCookie)).data?.authenticated, false);
  const limited = await login(password);
  assert.equal(limited.error?.code, 'LOGIN_RATE_LIMITED');
  assert(limited.error.retryAfterSeconds! > 0 && limited.error.retryAfterSeconds! <= 900);
  const replacement = 'новый пароль календаря';
  await resetPassword(pool, replacement, replacement);
  ip = '203.0.113.2';
  const replacementSession = await login(replacement);
  const replacementCookie = cookie(replacementSession.response);
  baseUrl = await recreate();
  assert.equal((await status(activeCookie)).data?.authenticated, false);
  assert.equal(
    (await status(replacementCookie)).data?.expiresAt,
    replacementSession.data!.expiresAt,
  );
  assert.equal((await login(password)).error?.code, 'INVALID_PASSWORD');
  console.log(
    'Пересоздание контейнера с тем же томом сохраняет пароль, сроки, отзыв и лимит входа.',
  );
} finally {
  await stopApi();
  await pool.end();
  await container('stop', name).catch(() => {});
  await container('delete', name).catch(() => {});
  await container('volume', 'delete', name);
}
