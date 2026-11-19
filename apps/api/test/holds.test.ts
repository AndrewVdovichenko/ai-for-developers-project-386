import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  createEventType,
  getSlotAvailability,
  guestSessionPrepareGuest,
  selectHold,
  releaseHold,
  getCurrentHold,
  getHold,
  getGuestOperation,
  guestSessionVerifyGuest,
  ownerAvailabilitySaveAvailability,
  ownerSessionLoginOwner,
} from '@calendar/api-client';
import type { SaveAvailability } from '@calendar/api-client';
import { resetPassword } from '../src/access.js';
import { createApp } from '../src/app.js';
import { testDatabase } from './database.js';

async function fixture(instant = '2026-11-17T04:10:00.000Z', durationMinutes = 20) {
  const db = await testDatabase();
  await db.migrate();
  let clock = new Date(instant);
  const password = 'пароль Слотов'; // betterleaks:allow -- public test fixture
  await resetPassword(db.pool, password, password);
  const origin = 'http://localhost:5173';
  let app = createApp({ pool: db.pool, origin, now: () => clock, decisionNow: () => clock });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const login = await ownerSessionLoginOwner({
    baseUrl,
    headers: { Origin: origin },
    body: { password },
  });
  const headers = {
    Origin: origin,
    Cookie: login.response!.headers.get('set-cookie')!.split(';')[0]!,
    'Idempotency-Key': randomUUID(),
  };
  const created = await createEventType({
    baseUrl,
    headers,
    body: { name: 'Звонок', durationMinutes },
  });
  const id = created.data!.eventType.id;
  const read = () => getSlotAvailability({ baseUrl, path: { id } });
  let revision = 0;
  return {
    pool: db.pool,
    async restart() {
      await app.close();
      app = createApp({ pool: db.pool, origin, now: () => clock, decisionNow: () => clock });
      const address = new URL(baseUrl);
      await app.listen({ host: '127.0.0.1', port: Number(address.port) });
    },
    async type(durationMinutes: number) {
      return (
        await createEventType({
          baseUrl,
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          body: { name: 'Другой тип', durationMinutes },
        })
      ).data!.eventType;
    },
    read,
    async guest() {
      const r = await guestSessionPrepareGuest({ baseUrl, headers: { Origin: origin }, body: {} });
      return { Origin: origin, Cookie: r.response!.headers.get('set-cookie')!.split(';')[0]! };
    },
    baseUrl,
    id,
    setClock: (value: string) => {
      clock = new Date(value);
    },
    async save(timeZone: string, intervals: SaveAvailability['days'][number]['intervals']) {
      const result = await ownerAvailabilitySaveAvailability({
        baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: {
          revision: revision++,
          timeZone,
          days: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, intervals })),
        },
      });
      expect(result.response!.status).toBe(200);
    },
    async close() {
      await app.close();
      await db.close();
    },
  };
}

test('Гость выбирает Слот один раз и восстанавливает исходный срок', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const body = { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' };
    const key = randomUUID();
    const first = await selectHold({
      baseUrl: f.baseUrl,
      headers: { ...headers, 'Idempotency-Key': key },
      body,
    });
    expect(first.response!.status).toBe(200);
    expect(first.data!.hold).toMatchObject({
      state: 'active',
      expiresAt: '2026-11-17T04:15:00.000Z',
    });
    expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold).toEqual(
      first.data!.hold,
    );
    f.setClock('2026-11-17T04:15:00.000Z');
    expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold!.state).toBe(
      'expired',
    );
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': key },
          body,
        })
      ).data,
    ).toEqual(first.data);
  } finally {
    await f.close();
  }
});

test('Два Гостя: один пересекающийся выбор, общая граница и сохранённый конфликт', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const a = await f.guest(),
      b = await f.guest();
    const otherType = await f.type(60);
    const blocked = await f.pool.connect();
    await blocked.query('BEGIN');
    await blocked.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
    const keyA = randomUUID(),
      keyB = randomUUID();
    const bodyA = { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' };
    const bodyB = { eventTypeId: otherType.id, startsAt: '2026-11-17T09:15:00.000Z' };
    const pendingA = selectHold({
      baseUrl: f.baseUrl,
      headers: { ...a, 'Idempotency-Key': keyA },
      body: bodyA,
    });
    const pendingB = selectHold({
      baseUrl: f.baseUrl,
      headers: { ...b, 'Idempotency-Key': keyB },
      body: bodyB,
    });
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await f.pool.query(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
              )
            ).rows[0].count,
          ),
        )
        .toBe(2);
    } finally {
      await blocked.query('ROLLBACK');
      blocked.release();
    }
    const results = await Promise.all([pendingA, pendingB]);
    expect(results.map((r) => r.response!.status).sort()).toEqual([200, 409]);
    // The losing guest is the response with a saved refusal.
    const index = results.findIndex((r) => r.error);
    const headers = index === 0 ? a : b;
    const key = index === 0 ? keyA : keyB;
    const body = index === 0 ? bodyA : bodyB;
    expect(
      (await getGuestOperation({ baseUrl: f.baseUrl, headers, path: { key } })).data,
    ).toMatchObject({
      state: 'completed',
      response: { status: 409, body: { code: 'SLOT_UNAVAILABLE' } },
    });
    const winner = results.find((r) => r.data)!.data!.hold;
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers, path: { id: winner.id } })).error!.code,
    ).toBe('HOLD_UNAVAILABLE');
    expect((await f.read()).data!.slots.some((slot) => slot.startsAt === winner.startsAt)).toBe(
      false,
    );
    f.setClock('2026-11-17T04:15:00.000Z');
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': key },
          body,
        })
      ).error!.code,
    ).toBe('SLOT_UNAVAILABLE');
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          body: { eventTypeId: f.id, startsAt: '2026-11-17T10:00:00.000Z' },
        })
      ).response!.status,
    ).toBe(200);
  } finally {
    await f.close();
  }
});

test('cookie не продлевается; чужие UUID и отсутствие cookie не дают доступ', async () => {
  const f = await fixture();
  try {
    const headers = await f.guest();
    expect((await guestSessionVerifyGuest({ baseUrl: f.baseUrl, headers })).data).toEqual({
      ready: true,
    });
    expect(
      (
        await guestSessionPrepareGuest({ baseUrl: f.baseUrl, headers, body: {} })
      ).response!.headers.get('set-cookie'),
    ).toBeNull();
    expect((await getCurrentHold({ baseUrl: f.baseUrl })).response!.status).toBe(401);
    expect((await getHold({ baseUrl: f.baseUrl, path: { id: 'invalid' } })).response!.status).toBe(
      404,
    );
  } finally {
    await f.close();
  }
});

test('После ожидания блокировки пять минут начинаются с актуального времени; общая граница свободна', async () => {
  const f = await fixture(undefined, 60);
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const a = await f.guest(),
      b = await f.guest();
    const blocker = await f.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
    const pending = selectHold({
      baseUrl: f.baseUrl,
      headers: { ...a, 'Idempotency-Key': randomUUID() },
      body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
    });
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await f.pool.query(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
              )
            ).rows[0].count,
          ),
        )
        .toBe(1);
      f.setClock('2026-11-17T04:12:00.123Z');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const first = await pending;
    expect(first.data).toMatchObject({
      serverNow: '2026-11-17T04:12:00.123Z',
      hold: { expiresAt: '2026-11-17T04:17:00.123Z' },
    });
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...a, 'Idempotency-Key': randomUUID() },
          body: { eventTypeId: f.id, startsAt: first.data!.hold.startsAt },
        })
      ).data!.hold,
    ).toEqual(first.data!.hold);
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...b, 'Idempotency-Key': randomUUID() },
          body: { eventTypeId: f.id, startsAt: '2026-11-17T10:00:00.000Z' },
        })
      ).response!.status,
    ).toBe(200);
  } finally {
    await f.close();
  }
});

test('Технический откат не оставляет Бронирование или результат операции', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const key = randomUUID();
    await f.pool.query(
      "CREATE FUNCTION reject_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER reject_operation BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION reject_operation()",
    );
    const body = { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' };
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': key },
          body,
        })
      ).response!.status,
    ).toBe(503);
    expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold).toBeNull();
    expect((await getGuestOperation({ baseUrl: f.baseUrl, headers, path: { key } })).data).toEqual({
      state: 'unknown',
    });
    await f.pool.query('DROP TRIGGER reject_operation ON operations');
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': key },
          body,
        })
      ).response!.status,
    ).toBe(200);
  } finally {
    await f.close();
  }
});

test('Перезапуск сохраняет исходный срок и исторический результат', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest(),
      key = randomUUID();
    const body = { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' };
    const first = (
      await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': key },
        body,
      })
    ).data!;
    f.setClock('2026-11-17T04:16:00.000Z');
    await f.restart();
    expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold).toMatchObject({
      id: first.hold.id,
      state: 'expired',
      expiresAt: first.hold.expiresAt,
    });
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': key },
          body,
        })
      ).data,
    ).toEqual(first);
  } finally {
    await f.close();
  }
});

test('Тайм-аут блокировки остаётся техническим и не сохраняет отказ Слота', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest(),
      key = randomUUID();
    const body = { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' };
    const blocker = await f.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
    try {
      expect(
        (
          await selectHold({
            baseUrl: f.baseUrl,
            headers: { ...headers, 'Idempotency-Key': key },
            body,
          })
        ).error!.code,
      ).toBe('TEMPORARILY_UNAVAILABLE');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect((await getGuestOperation({ baseUrl: f.baseUrl, headers, path: { key } })).data).toEqual({
      state: 'unknown',
    });
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': key },
          body,
        })
      ).response!.status,
    ).toBe(200);
  } finally {
    await f.close();
  }
});

test('Успешная замена пересекает собственный Слот и сохраняет исторический результат', async () => {
  const f = await fixture(undefined, 60);
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const key = randomUUID();
    const body = { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' };
    const first = (
      await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': key },
        body,
      })
    ).data!;
    f.setClock('2026-11-17T04:12:00.000Z');
    const next = await selectHold({
      baseUrl: f.baseUrl,
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      body: { ...body, startsAt: '2026-11-17T09:15:00.000Z' },
    });
    expect(next.response!.status).toBe(200);
    expect(next.data!.hold).toMatchObject({
      state: 'active',
      expiresAt: '2026-11-17T04:17:00.000Z',
    });
    expect(next.data!.hold.id).not.toBe(first.hold.id);
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers, path: { id: first.hold.id } })).data!.hold
        .state,
    ).toBe('replaced');
    expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold).toEqual(
      next.data!.hold,
    );
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': key },
          body,
        })
      ).data,
    ).toEqual(first);
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers, path: { id: first.hold.id } })).data!.hold
        .state,
    ).toBe('replaced');
  } finally {
    await f.close();
  }
});

test('Освобождение действует для active и expired; повторы не возобновляют выбор', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    for (const expired of [false, true]) {
      const selected = await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
      });
      const hold = selected.data!.hold;
      if (expired) f.setClock(hold.expiresAt);
      const key = randomUUID();
      const options = {
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': key },
        path: { id: hold.id },
        body: {},
      };
      const released = await releaseHold(options);
      expect(released.response!.status).toBe(200);
      expect(released.data!.hold).toMatchObject({
        id: hold.id,
        state: 'released',
        expiresAt: hold.expiresAt,
      });
      await f.restart();
      expect((await releaseHold(options)).data).toEqual(released.data);
      expect(
        (
          await releaseHold({
            ...options,
            headers: { ...headers, 'Idempotency-Key': randomUUID() },
          })
        ).data!.hold.state,
      ).toBe('released');
      expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold!.state).toBe(
        'released',
      );
      expect((await f.read()).data!.slots.some((s) => s.startsAt === hold.startsAt)).toBe(true);
    }
  } finally {
    await f.close();
  }
});

async function waitForLock(f: Awaited<ReturnType<typeof fixture>>, count = 1) {
  await expect
    .poll(async () =>
      Number(
        (
          await f.pool.query(
            "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
          )
        ).rows[0].count,
      ),
    )
    .toBe(count);
}

test('Неудачная замена сохраняет прежний выбор и срок; новый ключ допускает замену после освобождения препятствия', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const a = await f.guest(),
      b = await f.guest();
    const select = (headers: typeof a, startsAt: string, key = randomUUID()) =>
      selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': key },
        body: { eventTypeId: f.id, startsAt },
      });
    const old = (await select(a, '2026-11-17T09:00:00.000Z')).data!.hold;
    const obstacle = (await select(b, '2026-11-17T10:00:00.000Z')).data!.hold;
    const key = randomUUID();
    expect((await select(a, obstacle.startsAt, key)).error!.code).toBe('SLOT_UNAVAILABLE');
    expect((await getCurrentHold({ baseUrl: f.baseUrl, headers: a })).data!.hold).toEqual(old);
    await releaseHold({
      baseUrl: f.baseUrl,
      headers: { ...b, 'Idempotency-Key': randomUUID() },
      path: { id: obstacle.id },
      body: {},
    });
    expect((await select(a, obstacle.startsAt, key)).error!.code).toBe('SLOT_UNAVAILABLE');
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers: a, path: { id: old.id } })).data!.hold,
    ).toEqual(old);
    expect((await select(a, obstacle.startsAt)).response!.status).toBe(200);
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers: a, path: { id: old.id } })).data!.hold.state,
    ).toBe('replaced');
  } finally {
    await f.close();
  }
});

test('На границе срока новый выбор получает новый id и атомарно заменяет истёкший', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const select = () =>
      selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
      });
    const first = (await select()).data!.hold;
    const blocker = await f.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
    const pending = select();
    try {
      await waitForLock(f);
      f.setClock(first.expiresAt);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const second = (await pending).data!.hold;
    expect(second.id).not.toBe(first.id);
    expect(second.expiresAt).toBe('2026-11-17T04:20:00.000Z');
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers, path: { id: first.id } })).data!.hold.state,
    ).toBe('replaced');
  } finally {
    await f.close();
  }
});

test('Две одновременные замены одного Гостя оставляют только последний действующий выбор', async () => {
  const f = await fixture(undefined, 60);
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const select = (startsAt: string) =>
      selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: f.id, startsAt },
      });
    const first = (await select('2026-11-17T09:00:00.000Z')).data!.hold;
    const blocker = await f.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
    const a = select('2026-11-17T09:15:00.000Z');
    const b = select('2026-11-17T09:30:00.000Z');
    try {
      await waitForLock(f, 2);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const results = await Promise.all([a, b]);
    expect(results.map((r) => r.response!.status)).toEqual([200, 200]);
    const current = (await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold!;
    const states = await Promise.all(
      [first, ...results.map((r) => r.data!.hold)].map(
        async (h) =>
          (await getHold({ baseUrl: f.baseUrl, headers, path: { id: h.id } })).data!.hold,
      ),
    );
    expect(states.filter((h) => h.state === 'active').map((h) => h.id)).toEqual([current.id]);
    expect(states.filter((h) => h.state === 'replaced')).toHaveLength(2);
  } finally {
    await f.close();
  }
});

for (const releaseFirst of [true, false]) {
  test(`Освобождение и замена сериализуются: освобождение первым ${releaseFirst}`, async () => {
    const f = await fixture();
    try {
      await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
      const headers = await f.guest();
      const select = (startsAt: string) =>
        selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          body: { eventTypeId: f.id, startsAt },
        });
      const first = (await select('2026-11-17T09:00:00.000Z')).data!.hold;
      const blocker = await f.pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
      const release = () =>
        releaseHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          path: { id: first.id },
          body: {},
        });
      const replacement = () => select('2026-11-17T09:15:00.000Z');
      const one = releaseFirst ? release() : replacement();
      await waitForLock(f);
      const two = releaseFirst ? replacement() : release();
      try {
        await waitForLock(f, 2);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      const results = await Promise.all([one, two]);
      expect(results.map((r) => r.response!.status)).toEqual([200, 200]);
      expect(
        (await getHold({ baseUrl: f.baseUrl, headers, path: { id: first.id } })).data!.hold.state,
      ).toBe(releaseFirst ? 'released' : 'replaced');
      const current = (await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold!;
      expect(current).toMatchObject({ state: 'active', startsAt: '2026-11-17T09:15:00.000Z' });
    } finally {
      await f.close();
    }
  });
}

test('Откат замены и освобождения не меняет старый выбор и не сохраняет результат', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const old = (
      await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
      })
    ).data!.hold;
    await f.pool.query(
      "CREATE FUNCTION reject_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER reject_operation BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION reject_operation()",
    );
    for (const action of ['replace', 'release']) {
      const key = randomUUID(),
        options = { baseUrl: f.baseUrl, headers: { ...headers, 'Idempotency-Key': key } };
      const result =
        action === 'replace'
          ? await selectHold({
              ...options,
              body: { eventTypeId: f.id, startsAt: '2026-11-17T10:00:00.000Z' },
            })
          : await releaseHold({ ...options, path: { id: old.id }, body: {} });
      expect(result.response!.status).toBe(503);
      expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold).toEqual(old);
      expect(
        (await getGuestOperation({ baseUrl: f.baseUrl, headers, path: { key } })).data,
      ).toEqual({ state: 'unknown' });
    }
  } finally {
    await f.close();
  }
});

test('Освобождение проверяет принадлежность, пустое тело и общее пространство ключей', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest(),
      other = await f.guest(),
      key = randomUUID();
    const old = (
      await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': key },
        body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
      })
    ).data!.hold;
    const options = {
      baseUrl: f.baseUrl,
      headers: { ...headers, 'Idempotency-Key': key },
      path: { id: old.id },
      body: {},
    };
    expect((await releaseHold(options)).error!.code).toBe('IDEMPOTENCY_KEY_REUSED');
    for (const id of [old.id, randomUUID(), 'invalid']) {
      expect(
        (
          await releaseHold({
            ...options,
            headers: { ...other, 'Idempotency-Key': randomUUID() },
            path: { id },
          })
        ).error!.code,
      ).toBe('HOLD_UNAVAILABLE');
    }
    expect(
      (
        await releaseHold({
          ...options,
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          body: { extra: true },
        })
      ).error!.code,
    ).toBe('INVALID_REQUEST');
    expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold).toEqual(old);
  } finally {
    await f.close();
  }
});
