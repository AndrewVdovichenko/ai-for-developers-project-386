import type pg from 'pg';
import { AccessError } from './access.js';
import { transaction } from './database.js';

export const ownerSubject = 'owner:1';
export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
function operationKey(value: unknown) {
  if (!isUuid(value))
    throw new AccessError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Требуется ключ операции UUID');
  return value.toLowerCase();
}
export type OperationResponse = { status: number; body: unknown };

export async function readOperation(pool: pg.Pool, subject: string, key: string) {
  const result = await pool.query<OperationResponse>(
    'SELECT status, body FROM operations WHERE subject = $1 AND key = $2',
    [subject, operationKey(key)],
  );
  return result.rows[0]
    ? { state: 'completed' as const, response: result.rows[0] }
    : { state: 'unknown' as const };
}

// Every action uses the same subject/key namespace and the calendar lock.
// JSONB equality ignores object property order, including in invalid requests.
export async function runOperation(
  pool: pg.Pool,
  operation: { subject: string; key: unknown; action: string; parameters: unknown },
  execute: (client: pg.PoolClient) => Promise<OperationResponse>,
) {
  const key = operationKey(operation.key);
  return transaction(pool, async (client) => {
    const calendar = await client.query('SELECT id FROM calendar WHERE id = 1 FOR UPDATE');
    if (calendar.rowCount !== 1) throw new Error('Календарь не создан');
    const previous = await client.query<OperationResponse & { matches: boolean }>(
      `SELECT status, body, action = $3 AND parameters = $4::jsonb AS matches
       FROM operations WHERE subject = $1 AND key = $2`,
      [operation.subject, key, operation.action, JSON.stringify(operation.parameters)],
    );
    const row = previous.rows[0];
    if (row) {
      if (!row.matches)
        return {
          status: 409,
          body: {
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'Ключ уже использован для другой операции или параметров',
          },
        };
      return { status: row.status, body: row.body };
    }
    const result = await execute(client);
    await client.query(
      'INSERT INTO operations (subject, key, action, parameters, status, body) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        operation.subject,
        key,
        operation.action,
        JSON.stringify(operation.parameters),
        result.status,
        JSON.stringify(result.body),
      ],
    );
    return result;
  });
}
