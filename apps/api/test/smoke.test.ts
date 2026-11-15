import { getStatus } from '@calendar/api-client';
import { expect, test } from 'vitest';
import { createApp } from '../src/app.js';
test('сервер запускается и отвечает 200 на GET / через SDK', async () => {
  const app = createApp();
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const { response } = await getStatus({ baseUrl, throwOnError: true });
    expect(response.status).toBe(200);
  } finally {
    await app.close();
  }
});
