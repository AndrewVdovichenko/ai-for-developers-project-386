import { createApp } from './app.js';
import { createPool } from './database.js';
import { config } from './config.js';
const settings = config();
const pool = createPool(settings.databaseUrl);
const app = createApp({ pool, origin: settings.origin, trustProxy: settings.trustProxy });
app.addHook('onClose', () => pool.end());
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close();
  });
}
try {
  await app.listen({
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 3000),
  });
} catch {
  app.log.error('API не запущен: проверьте доступность БД и совместимость миграций');
  await app.close();
  process.exitCode = 1;
}
