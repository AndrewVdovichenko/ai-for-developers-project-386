import { createApp } from '../src/app.js';
import { resetPassword } from '../src/access.js';
import { testDatabase } from './database.js';

const db = await testDatabase();
try {
  await db.migrate();
  const password = 'тестовый пароль Владельца'; // betterleaks:allow -- public test fixture
  await resetPassword(db.pool, password, password);
  // Fixed authoritative clock makes DST and browser date boundaries reproducible.
  const app = createApp({
    pool: db.pool,
    origin: 'http://127.0.0.1:4174',
    now: () => new Date('2026-10-24T22:00:00.000Z'),
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      void app
        .close()
        .then(() => db.close())
        .then(() => process.exit());
    });
  await app.listen({ host: '127.0.0.1', port: 3001 });
} catch {
  await db.close();
  process.exitCode = 1;
}
