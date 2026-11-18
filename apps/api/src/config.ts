import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export function config() {
  const production = process.env.NODE_ENV === 'production';
  const databaseUrl =
    process.env.DATABASE_URL ??
    (production ? undefined : 'postgresql://postgres@127.0.0.1:5432/calendar');
  const origin = process.env.APP_ORIGIN ?? (production ? undefined : 'http://127.0.0.1:5173');
  if (!databaseUrl || !origin) throw new Error('Задайте DATABASE_URL и APP_ORIGIN');
  return {
    databaseUrl,
    origin,
    trustProxy: process.env.TRUSTED_PROXIES?.split(',').filter(Boolean),
  };
}
