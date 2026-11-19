import { useCallback, useEffect, useRef, useState } from 'react';
import { getSlotAvailability } from '@calendar/api-client';
import type { SlotAvailability } from '@calendar/api-client';
import { SlotCalendar } from './SlotCalendar';

export function BookingCalendar({ id }: { id: string }) {
  const [data, setData] = useState<SlotAvailability>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [day, setDay] = useState('');
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await getSlotAvailability({
        baseUrl: window.location.origin,
        path: { id },
        signal: AbortSignal.timeout(15_000),
      });
      if (current !== generation.current) return;
      if (!result.data) throw new Error('unavailable');
      setData(result.data);
      setError(false);
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [id]);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void refresh();
    });
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    // Future Hold conflicts dispatch this after a failed mutating choice.
    window.addEventListener('calendar:availability-conflict', visible);
    const timer = window.setInterval(visible, 60_000);
    return () => {
      active = false;
      invalidate();
      window.clearInterval(timer);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('calendar:availability-conflict', visible);
    };
  }, [refresh, invalidate]);
  return (
    <SlotCalendar
      data={data}
      loading={loading}
      error={error}
      day={day}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      onDayChange={(value) => {
        setDay(value);
        void refresh();
      }}
      onRetry={() => void refresh()}
    />
  );
}
