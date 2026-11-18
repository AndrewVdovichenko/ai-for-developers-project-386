import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  ownerAvailabilityGetAvailability as get,
  ownerAvailabilitySaveAvailability as put,
  ownerSessionLoginOwner,
  getOwnerOperation,
  createEventType,
} from '@calendar/api-client';
import type { SaveAvailability } from '@calendar/api-client';
import { resetPassword } from '../src/access.js';
import { createApp } from '../src/app.js';
import { testDatabase } from './database.js';

const origin = 'http://localhost:5173';
const days = (): SaveAvailability['days'] =>
  Array.from({ length: 7 }, (_, index) => ({ weekday: index + 1, intervals: [] }));
async function fixture() {
  const db = await testDatabase();
  await db.migrate();
  const password = 'пароль недельного Расписания'; // betterleaks:allow -- public test fixture
  await resetPassword(db.pool, password, password);
  const app = createApp({ pool: db.pool, origin });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const login = await ownerSessionLoginOwner({
    baseUrl,
    headers: { Origin: origin },
    body: { password },
  });
  const headers = {
    Origin: origin,
    Cookie: login.response!.headers.get('set-cookie')!.split(';')[0]!,
  };
  return {
    db,
    app,
    baseUrl,
    headers,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

test('первое Расписание: семь выходных, явный пояс и полная атомарная неделя', async () => {
  const f = await fixture();
  try {
    expect((await get(f)).data).toMatchObject({
      availability: { configured: false, timeZone: null, revision: 0, days: days() },
    });
    const body = { revision: 0, timeZone: 'Asia/Yekaterinburg', days: days() };
    const result = await put({
      ...f,
      headers: { ...f.headers, 'Idempotency-Key': randomUUID() },
      body,
    });
    expect(result.response!.status).toBe(200);
    expect(result.data?.availability).toEqual({ ...body, configured: true, revision: 1 });
    expect((await get(f)).data?.availability).toEqual(result.data?.availability);
  } finally {
    await f.close();
  }
});

test('две вкладки: только одна версия сохраняется; смена пояса требует preview; ключи общие', async () => {
  const f = await fixture();
  try {
    const body = { revision: 0, timeZone: 'Europe/Berlin', days: days() };
    const send = (key: string, parameters = body) =>
      put({ ...f, headers: { ...f.headers, 'Idempotency-Key': key }, body: parameters });
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.all(keys.map((key) => send(key)));
    expect(results.map((result) => result.response!.status).sort()).toEqual([200, 409]);
    const failed = results.findIndex((result) => result.response!.status === 409);
    expect(results[failed]?.error?.code).toBe('REVISION_CONFLICT');
    expect((await send(keys[failed]!)).error).toEqual(results[failed]?.error);
    const changed = { ...body, revision: 1, timeZone: 'Asia/Yekaterinburg' };
    expect((await send(randomUUID(), changed)).error?.code).toBe('PREVIEW_REQUIRED');
    expect((await send(randomUUID(), { ...changed, revision: 0 })).error?.code).toBe(
      'REVISION_CONFLICT',
    );
    const winner = keys[1 - failed]!;
    expect((await send(winner, { ...body, revision: 1 })).error?.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(
      (
        await createEventType({
          ...f,
          headers: { ...f.headers, 'Idempotency-Key': winner },
          body: { name: 'Тип', durationMinutes: 30 },
        })
      ).error?.code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await get(f)).data?.availability.revision).toBe(1);
  } finally {
    await f.close();
  }
});

test('ошибки полной недели сохраняются как окончательные отказы без частичного изменения', async () => {
  const f = await fixture();
  try {
    const valid = { revision: 0, timeZone: 'Europe/Berlin', days: days() };
    const invalid: unknown[] = [
      null,
      [],
      'week',
      { ...valid, extra: true },
      { ...valid, revision: '0' },
      { ...valid, revision: 0.5 },
      { ...valid, timeZone: null },
      { ...valid, timeZone: 'Invalid/Zone' },
      { ...valid, timeZone: '+05:00' },
      { ...valid, days: [] },
      { ...valid, days: [...days().slice(0, 6), days()[0]] },
    ];
    for (const intervals of [
      [{ startMinute: -1, endMinute: 60 }],
      [{ startMinute: 1440, endMinute: 1440 }],
      [{ startMinute: 0, endMinute: 1441 }],
      [{ startMinute: 60, endMinute: 60 }],
      [{ startMinute: 0.5, endMinute: 60 }],
      [{ startMinute: '0', endMinute: 60 }],
      [
        { startMinute: 0, endMinute: 100 },
        { startMinute: 90, endMinute: 110 },
      ],
      [{ startMinute: 0, endMinute: 60, extra: true }],
      null,
    ])
      invalid.push({ ...valid, days: [{ weekday: 1, intervals }, ...days().slice(1)] });
    for (const body of invalid) {
      const key = randomUUID();
      const result = await put({
        ...f,
        headers: { ...f.headers, 'Idempotency-Key': key },
        body: body as SaveAvailability,
      });
      expect(result.error?.code, JSON.stringify(body)).toBe('VALIDATION_FAILED');
      expect((await getOwnerOperation({ ...f, path: { key } })).data).toMatchObject({
        state: 'completed',
        response: { status: 400, body: result.error },
      });
    }
    expect((await get(f)).data?.availability).toEqual({
      configured: false,
      revision: 0,
      timeZone: null,
      days: days(),
    });
  } finally {
    await f.close();
  }
});

test('интервалы сортируются и объединяются; канонический повтор не увеличивает revision', async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    const body = { revision: 0, timeZone: 'Asia/Yekaterinburg', days: days() };
    body.days[0]!.intervals = [
      { startMinute: 600, endMinute: 1440 },
      { startMinute: 540, endMinute: 600 },
    ];
    const result = await put({ ...f, headers: { ...f.headers, 'Idempotency-Key': key }, body });
    expect(result.data?.availability.days[0]?.intervals).toEqual([
      { startMinute: 540, endMinute: 1440 },
    ]);
    body.days[0]!.intervals = [{ startMinute: 540, endMinute: 1440 }];
    body.days.reverse();
    expect(
      (await put({ ...f, headers: { ...f.headers, 'Idempotency-Key': key }, body })).data,
    ).toEqual(result.data);
    expect((await get(f)).data?.availability.revision).toBe(1);
    expect((await getOwnerOperation({ ...f, path: { key } })).data).toEqual({
      state: 'completed',
      response: { status: 200, body: result.data },
    });
  } finally {
    await f.close();
  }
});

test('доступ и источник защищены; сбой БД откатывает неделю и результат; после перезапуска повтор безопасен', async () => {
  const f = await fixture();
  let restarted: ReturnType<typeof createApp> | undefined;
  try {
    const body = { revision: 0, timeZone: 'Europe/Berlin', days: days() };
    const key = randomUUID();
    expect((await get({ baseUrl: f.baseUrl })).error?.code).toBe('OWNER_AUTH_REQUIRED');
    expect(
      (await put({ baseUrl: f.baseUrl, body, headers: { Origin: origin, 'Idempotency-Key': key } }))
        .error?.code,
    ).toBe('OWNER_AUTH_REQUIRED');
    expect(
      (
        await put({
          ...f,
          body,
          headers: { ...f.headers, Origin: 'https://untrusted.test', 'Idempotency-Key': key },
        })
      ).error?.code,
    ).toBe('ORIGIN_NOT_ALLOWED');
    expect(
      (await put({ ...f, body, headers: { ...f.headers, 'Idempotency-Key': '' } })).error?.code,
    ).toBe('IDEMPOTENCY_KEY_REQUIRED');
    await f.db.pool.query(
      `CREATE FUNCTION fail_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER fail_save BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION fail_save()`,
    );
    expect(
      (await put({ ...f, body, headers: { ...f.headers, 'Idempotency-Key': key } })).response!
        .status,
    ).toBe(503);
    expect((await get(f)).data?.availability.revision).toBe(0);
    expect((await getOwnerOperation({ ...f, path: { key } })).data).toEqual({ state: 'unknown' });
    await f.db.pool.query('DROP TRIGGER fail_save ON operations');
    const result = await put({ ...f, body, headers: { ...f.headers, 'Idempotency-Key': key } });
    await f.app.close();
    restarted = createApp({ pool: f.db.pool, origin });
    const baseUrl = await restarted.listen({ host: '127.0.0.1', port: 0 });
    expect(
      (await put({ baseUrl, body, headers: { ...f.headers, 'Idempotency-Key': key } })).data,
    ).toEqual(result.data);
    expect((await get({ baseUrl, headers: f.headers })).data?.availability.revision).toBe(1);
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test('ожидание общей блокировки ограничено и не превращается в бизнес-конфликт', async () => {
  const f = await fixture();
  const blocker = await f.db.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM calendar WHERE id = 1 FOR UPDATE');
    const key = randomUUID();
    const result = await put({
      ...f,
      body: { revision: 0, timeZone: 'Europe/Berlin', days: days() },
      headers: { ...f.headers, 'Idempotency-Key': key },
    });
    expect(result.error?.code).toBe('TEMPORARILY_UNAVAILABLE');
    expect((await getOwnerOperation({ ...f, path: { key } })).data).toEqual({ state: 'unknown' });
    expect((await get(f)).data?.availability.revision).toBe(0);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await f.close();
  }
});
