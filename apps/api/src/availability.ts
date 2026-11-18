import type pg from 'pg';
import { ownerSubject, runOperation } from './operations.js';

type WorkingInterval = { startMinute: number; endMinute: number };
type WeeklyDay = { weekday: number; intervals: WorkingInterval[] };
type SaveAvailability = {
  revision: number;
  timeZone: string;
  days: WeeklyDay[];
  confirmationToken?: string;
};
const columns = 'time_zone AS "timeZone", revision, days, (time_zone IS NOT NULL) AS configured';
export async function getAvailability(pool: pg.Pool) {
  const result = await pool.query(
    `SELECT ${columns}, clock_timestamp() AS "serverNow" FROM calendar WHERE id = 1`,
  );
  const { serverNow, ...availability } = result.rows[0];
  return { availability, serverNow: serverNow.toISOString() };
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
function normalize(input: unknown) {
  const fieldErrors: { field: string; code: string; message: string }[] = [];
  const invalid = (field: string, message: string) =>
    fieldErrors.push({ field, code: 'INVALID_VALUE', message });
  function model(
    value: unknown,
    path: string,
    allowed: string[],
  ): value is Record<string, unknown> {
    if (!object(value)) {
      invalid(path, 'Ожидается объект');
      return false;
    }
    for (const key of Object.keys(value))
      if (!allowed.includes(key)) invalid(path ? `${path}.${key}` : key, 'Неизвестное поле');
    return true;
  }
  if (!model(input, '', ['revision', 'timeZone', 'days', 'confirmationToken']))
    return { fieldErrors, parameters: input ?? null };
  if (!integer(input.revision, 0, 2147483646))
    invalid('revision', 'Ожидается целая версия Расписания');
  let timeZone = input.timeZone;
  try {
    if (typeof timeZone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timeZone))
      throw new Error();
    timeZone = new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;
  } catch {
    invalid('timeZone', 'Выберите поддерживаемый IANA-пояс');
  }
  if (input.confirmationToken !== undefined && typeof input.confirmationToken !== 'string')
    invalid('confirmationToken', 'Ожидается строка');
  const days: WeeklyDay[] = [];
  const weekdays = new Set<number>();
  if (!Array.isArray(input.days) || input.days.length !== 7)
    invalid('days', 'Укажите ровно семь дней недели');
  if (Array.isArray(input.days))
    input.days.forEach((day: unknown, index: number) => {
      const path = `days.${index}`;
      if (!model(day, path, ['weekday', 'intervals'])) return;
      if (!integer(day.weekday, 1, 7) || weekdays.has(day.weekday))
        invalid(`${path}.weekday`, 'Дни 1–7 должны быть уникальны');
      else weekdays.add(day.weekday);
      const intervals: WorkingInterval[] = [];
      if (!Array.isArray(day.intervals))
        invalid(`${path}.intervals`, 'Ожидается список интервалов');
      else
        day.intervals.forEach((interval: unknown, position: number) => {
          const field = `${path}.intervals.${position}`;
          if (!model(interval, field, ['startMinute', 'endMinute'])) return;
          const { startMinute, endMinute } = interval;
          const startValid = integer(startMinute, 0, 1439);
          const endValid = integer(endMinute, 1, 1440);
          if (!startValid) invalid(`${field}.startMinute`, 'Начало — целая минута от 0 до 1439');
          if (!endValid || (startValid && endValid && endMinute <= startMinute))
            invalid(`${field}.endMinute`, 'Конец должен быть позже начала и не позже 24:00');
          if (startValid && endValid) intervals.push({ startMinute, endMinute });
        });
      const merged: WorkingInterval[] = [];
      for (const interval of intervals.sort(
        (left, right) => left.startMinute - right.startMinute,
      )) {
        const previous = merged.at(-1);
        if (previous && previous.endMinute > interval.startMinute)
          invalid(`${path}.intervals`, 'Интервалы не должны пересекаться');
        if (previous?.endMinute === interval.startMinute) previous.endMinute = interval.endMinute;
        else merged.push(interval);
      }
      if (integer(day.weekday, 1, 7)) days.push({ weekday: day.weekday, intervals: merged });
    });
  const parameters = fieldErrors.length
    ? input
    : { ...input, timeZone, days: days.sort((left, right) => left.weekday - right.weekday) };
  return { fieldErrors, parameters };
}
export function saveAvailability(pool: pg.Pool, key: unknown, input: unknown) {
  const { fieldErrors, parameters } = normalize(input);
  return runOperation(
    pool,
    { subject: ownerSubject, key, action: 'saveAvailability', parameters },
    async (client) => {
      if (fieldErrors.length)
        return {
          status: 400,
          body: { code: 'VALIDATION_FAILED', message: 'Проверьте поля Расписания', fieldErrors },
        };
      const fields = parameters as SaveAvailability;
      const current = (
        await client.query<{ revision: number; timeZone: string | null }>(
          'SELECT revision, time_zone AS "timeZone" FROM calendar WHERE id = 1',
        )
      ).rows[0]!;
      if (current.revision !== fields.revision)
        return {
          status: 409,
          body: {
            code: 'REVISION_CONFLICT',
            message:
              'Расписание изменилось в другой вкладке. Согласуйте черновик с актуальной версией.',
          },
        };
      if (current.timeZone !== null && current.timeZone !== fields.timeZone)
        return {
          status: 409,
          body: {
            code: 'PREVIEW_REQUIRED',
            message: 'Для смены пояса нужен предварительный просмотр последствий',
          },
        };
      const result = await client.query(
        `UPDATE calendar SET time_zone = $1, days = $2, revision = revision + 1 WHERE id = 1 RETURNING ${columns}, clock_timestamp() AS "serverNow"`,
        [fields.timeZone, JSON.stringify(fields.days)],
      );
      const { serverNow, ...availability } = result.rows[0];
      return { status: 200, body: { availability, serverNow: serverNow.toISOString() } };
    },
  );
}
