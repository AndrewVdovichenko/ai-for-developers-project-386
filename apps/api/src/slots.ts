import type pg from 'pg';
import { getEventType } from './event-types.js';

import { calculateSlots } from './slot-calculation.js';
import type { WeeklyDay } from './slot-calculation.js';

// Walk actual instants, rather than resolving ambiguous wall times. Each contiguous
// run belongs to one normalized working interval, including gaps/folds in its clock.
// The same construction can be filtered against shared Holds/Bookings later.
export async function getSlotAvailability(pool: pg.Pool, id: string, now: () => Date) {
  const type = await getEventType(pool, id);
  if (!type) return undefined;
  const settings = (
    await pool.query<{ timeZone: string | null; days: WeeklyDay[] }>(
      'SELECT time_zone AS "timeZone", days FROM calendar WHERE id = 1',
    )
  ).rows[0]!;
  return calculateSlots(settings, type.durationMinutes, now());
}
