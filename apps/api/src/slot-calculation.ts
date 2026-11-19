type Interval = { startMinute: number; endMinute: number };
export type WeeklyDay = { weekday: number; intervals: Interval[] };
const minute = 60_000;
const day = 1440 * minute;

// Mutating Hold/Booking transactions reuse this with settings read by their
// transaction client and the authoritative decision time after locking.
export function calculateSlots(
  settings: { timeZone: string | null; days: WeeklyDay[] },
  durationMinutes: number,
  serverNow: Date,
) {
  const empty = {
    configured: settings.timeZone !== null,
    serverNow: serverNow.toISOString(),
    timeZone: settings.timeZone,
    windowStartsAt: null,
    windowEndsAt: null,
    slots: [],
  };
  if (!settings.timeZone) return empty;
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  function local(stamp: number) {
    const parts = Object.fromEntries(
      format.formatToParts(stamp).map((part) => [part.type, part.value]),
    );
    return {
      date: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)),
      clock: Number(parts.hour) * 60 + Number(parts.minute),
    };
  }
  const today = local(serverNow.getTime()).date;
  const after = today + 14 * day;
  let windowStart: number | undefined;
  let windowEnd: number | undefined;
  const runs: { start: number; end: number; candidates: number[]; key: string }[] = [];
  let previous: (typeof runs)[number] | undefined;
  // IANA offsets fit within this padding, even when a whole local date is skipped.
  for (let stamp = today - 2 * day; stamp <= after + 2 * day; stamp += minute) {
    const current = local(stamp);
    if (current.date < today) continue;
    if (windowStart === undefined) windowStart = stamp;
    if (current.date >= after) {
      windowEnd = stamp;
      break;
    }
    const weekday = new Date(current.date).getUTCDay() || 7;
    const intervals = settings.days.find((item) => item.weekday === weekday)!.intervals;
    const index = intervals.findIndex(
      (interval) => current.clock >= interval.startMinute && current.clock < interval.endMinute,
    );
    if (index < 0) {
      previous = undefined;
      continue;
    }
    const key = `${current.date}:${index}`;
    if (!previous || previous.key !== key || previous.end !== stamp) {
      previous = { start: stamp, end: stamp, candidates: [], key };
      runs.push(previous);
    }
    previous.end = stamp + minute;
    if ((current.clock - intervals[index]!.startMinute) % 15 === 0 && stamp >= serverNow.getTime())
      previous.candidates.push(stamp);
  }
  const duration = durationMinutes * minute;
  const slots = runs.flatMap((run) =>
    run.candidates
      .filter((start) => start + duration <= run.end && start + duration <= windowEnd!)
      .map((start) => ({
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + duration).toISOString(),
      })),
  );
  return {
    ...empty,
    windowStartsAt: new Date(windowStart!).toISOString(),
    windowEndsAt: new Date(windowEnd!).toISOString(),
    slots,
  };
}
