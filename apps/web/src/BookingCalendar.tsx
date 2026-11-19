import { Alert, Button, Stack, Text, Title } from '@mantine/core';
import {
  getCurrentHold,
  selectHold,
  getGuestOperation,
  guestSessionVerifyGuest,
} from '@calendar/api-client';
import type { Hold, Slot } from '@calendar/api-client';
import { ensureGuest } from './guest-api';
import { operationStorage } from './operation-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSlotAvailability } from '@calendar/api-client';
import type { SlotAvailability } from '@calendar/api-client';
import { SlotCalendar } from './SlotCalendar';

export function BookingCalendar({ id }: { id: string }) {
  const [hold, setHold] = useState<Hold>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [unresolved, setUnresolved] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const deadline = useRef(0);
  const storage = useRef<
    ReturnType<
      typeof operationStorage<{
        key: string;
        fingerprint: string;
        eventTypeId: string;
        startsAt: string;
      }>
    >
  >(undefined);
  const showHold = useCallback((value: Hold | null, serverNow: string) => {
    setHold(value ?? undefined);
    deadline.current = value
      ? performance.now() + Math.max(0, Date.parse(value.expiresAt) - Date.parse(serverNow))
      : 0;
    setRemaining(Math.max(0, Math.ceil((deadline.current - performance.now()) / 1000)));
  }, []);
  useEffect(() => {
    storage.current = operationStorage('guest-selection', 'guest_selection', (context) => context);
    let active = true;
    const recover = async () => {
      try {
        const context = storage.current?.load();
        if (context) {
          setUnresolved(true);
          const result = await getGuestOperation({
            baseUrl: location.origin,
            path: { key: context.key },
            signal: AbortSignal.timeout(15000),
          });
          if (result.data?.state === 'completed') {
            const response = result.data.response;
            if (response.status >= 400 && 'message' in response.body) {
              setMessage(response.body.message);
              window.dispatchEvent(new Event('calendar:availability-conflict'));
            }
            storage.current?.clear();
            setUnresolved(false);
          } else if (result.data?.state === 'unknown') {
            const verified = await guestSessionVerifyGuest({
              baseUrl: location.origin,
              signal: AbortSignal.timeout(15000),
            });
            if (!verified.data?.ready)
              throw new Error('Принадлежность прежнего выбора не подтверждена');
            const replay = await selectHold({
              baseUrl: location.origin,
              headers: { 'Idempotency-Key': context.key },
              body: { eventTypeId: context.eventTypeId, startsAt: context.startsAt },
              signal: AbortSignal.timeout(15000),
            });
            if (
              replay.data ||
              (replay.error &&
                replay.response!.status >= 400 &&
                replay.response!.status < 500 &&
                replay.response!.status !== 401)
            ) {
              storage.current?.clear();
              setUnresolved(false);
            } else throw new Error('Исход выбора пока неизвестен');
          }
        }
        if (storage.current?.load()) throw new Error('Исход выбора пока неизвестен');
        const current = await getCurrentHold({
          baseUrl: location.origin,
          signal: AbortSignal.timeout(15000),
        });
        if (active && current.data) showHold(current.data.hold, current.data.serverNow);
      } catch {
        if (active)
          setMessage('Не удалось восстановить выбор. Обновите страницу для повторной проверки.');
      }
    };
    void recover();
    const timer = window.setInterval(
      () => setRemaining(Math.max(0, Math.ceil((deadline.current - performance.now()) / 1000))),
      1000,
    );
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [showHold]);
  const choose = async (slot: Slot) => {
    if (busy || storage.current?.load()) return;
    setBusy(true);
    setMessage('');
    try {
      await ensureGuest();
      const context = {
        key: crypto.randomUUID(),
        fingerprint: JSON.stringify([id, slot.startsAt]),
        eventTypeId: id,
        startsAt: slot.startsAt,
      };
      if (!storage.current?.persist(context))
        throw new Error(
          'Не удалось сохранить ключ операции. Разрешите хранилище браузера и cookie.',
        );
      setUnresolved(true);
      const result = await selectHold({
        baseUrl: location.origin,
        headers: { 'Idempotency-Key': context.key },
        body: { eventTypeId: id, startsAt: slot.startsAt },
        signal: AbortSignal.timeout(15000),
      });
      if (result.data) {
        storage.current.clear();
        setUnresolved(false);
        showHold(result.data.hold, result.data.serverNow);
      } else if (
        result.error &&
        result.response!.status >= 400 &&
        result.response!.status < 500 &&
        result.response!.status !== 401
      ) {
        storage.current.clear();
        setUnresolved(false);
        setMessage(result.error.message);
        window.dispatchEvent(new Event('calendar:availability-conflict'));
      } else throw new Error('Ответ потерян. Обновите страницу для проверки результата.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось выполнить выбор');
    } finally {
      setBusy(false);
    }
  };
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
    <Stack>
      {unresolved && <Button onClick={() => location.reload()}>Проверить результат выбора</Button>}
      {message && (
        <Alert color="red" role="alert">
          {message}
        </Alert>
      )}
      {hold ? (
        <Stack aria-label="Выбранное Бронирование">
          <Title order={3}>Слот выбран</Title>
          <Text>
            {new Date(hold.startsAt).toLocaleString()} — {new Date(hold.endsAt).toLocaleString()}
          </Text>
          <Text role="timer">
            {remaining > 0
              ? `Осталось ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
              : 'Срок Бронирования истёк'}
          </Text>
          <Text size="sm">Номер Бронирования: {hold.id}</Text>
        </Stack>
      ) : (
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
          onSelect={busy || unresolved ? undefined : (slot) => void choose(slot)}
          onRetry={() => void refresh()}
        />
      )}
    </Stack>
  );
}
