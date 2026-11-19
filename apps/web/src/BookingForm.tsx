import { Alert, Button, Stack, TextInput } from '@mantine/core';
import { confirmHold, getGuestOperation } from '@calendar/api-client';
import type { ApiError, BookingResponse, Hold, OperationResponse } from '@calendar/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  clearBookingDraft,
  confirmationStorage,
  loadBookingDraft,
  saveBookingDraft,
} from './booking-draft';
import type { ConfirmationContext } from './booking-draft';

export function BookingForm({
  hold,
  disabled,
  onLocked,
}: {
  hold: Hold;
  disabled: boolean;
  onLocked: (locked: boolean) => void;
}) {
  const navigate = useNavigate();
  const [body, setBody] = useState(loadBookingDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [unresolved, setUnresolved] = useState(false);
  const working = useRef(false);
  const storage = useRef<ReturnType<typeof confirmationStorage>>(undefined);
  const complete = useCallback(
    (response: OperationResponse) => {
      if (response.status === 200 && 'booking' in response.body) {
        const context = storage.current?.load();
        if (context)
          storage.current?.persist({
            key: context.key,
            fingerprint: context.fingerprint,
            holdId: context.holdId,
            bookingId: (response.body as BookingResponse).booking.id,
          });
        clearBookingDraft();
        navigate(`/bookings/${(response.body as BookingResponse).booking.id}`, { replace: true });
        return;
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 401) {
        storage.current?.clear();
        setUnresolved(false);
        onLocked(false);
        const error = response.body as ApiError;
        setMessage(error.message);
        setErrors(Object.fromEntries((error.fieldErrors ?? []).map((e) => [e.field, e.message])));
        window.dispatchEvent(new Event('calendar:availability-conflict'));
        return;
      }
      throw new Error('Исход подтверждения пока неизвестен. Проверьте результат.');
    },
    [navigate, onLocked],
  );
  const recover = useCallback(async () => {
    if (working.current) return;
    const context = storage.current?.load();
    if (!context) return;
    working.current = true;
    setBusy(true);
    setUnresolved(true);
    onLocked(true);
    try {
      const result = await getGuestOperation({
        baseUrl: location.origin,
        path: { key: context.key },
        signal: AbortSignal.timeout(15000),
      });
      if (result.data?.state === 'completed') complete(result.data.response);
      else if (result.data?.state === 'unknown' && context.body) {
        const replay = await confirmHold({
          baseUrl: location.origin,
          headers: { 'Idempotency-Key': context.key },
          path: { id: context.holdId },
          body: context.body,
          signal: AbortSignal.timeout(15000),
        });
        if (replay.data) complete({ status: 200, body: replay.data });
        else if (replay.error && replay.response)
          complete({ status: replay.response.status, body: replay.error });
        else throw new Error('Исход подтверждения пока неизвестен');
      } else
        setMessage('Исход подтверждения пока неизвестен. Сначала проверьте прежний результат.');
    } catch {
      setMessage('Исход подтверждения пока неизвестен. Проверьте результат.');
    } finally {
      working.current = false;
      setBusy(false);
    }
  }, [complete, onLocked]);
  useEffect(() => {
    storage.current = confirmationStorage();
    if (storage.current.load() && !storage.current.load()?.bookingId) void recover();
  }, [recover]);
  const submit = async () => {
    if (working.current || disabled || storage.current?.load()) return;
    const normalized = { guestName: body.guestName.trim(), guestEmail: body.guestEmail.trim() };
    const next: Record<string, string> = {};
    if ([...normalized.guestName].length < 1 || [...normalized.guestName].length > 100)
      next.guestName = 'Введите имя от 1 до 100 символов';
    if (
      [...normalized.guestEmail].length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized.guestEmail)
    )
      next.guestEmail = 'Введите email до 254 символов в формате имя@домен.зона';
    setErrors(next);
    if (Object.keys(next).length) return;
    working.current = true;
    setBusy(true);
    setMessage('');
    onLocked(true);
    try {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify([hold.id, normalized])),
      );
      const context: ConfirmationContext = {
        key: crypto.randomUUID(),
        holdId: hold.id,
        body: normalized,
        fingerprint: Array.from(new Uint8Array(digest), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join(''),
      };
      if (!storage.current?.persist(context))
        throw new Error(
          'Не удалось сохранить ключ операции. Разрешите хранилище браузера и cookie.',
        );
      setUnresolved(true);
      const result = await confirmHold({
        baseUrl: location.origin,
        path: { id: hold.id },
        headers: { 'Idempotency-Key': context.key },
        body: normalized,
        signal: AbortSignal.timeout(15000),
      });
      if (result.data) complete({ status: 200, body: result.data });
      else if (result.error && result.response)
        complete({ status: result.response.status, body: result.error });
      else throw new Error('Исход подтверждения пока неизвестен. Проверьте результат.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Исход подтверждения пока неизвестен');
    } finally {
      working.current = false;
      setBusy(false);
      if (!storage.current?.load()) onLocked(false);
    }
  };
  if (hold.state === 'confirmed') return null;
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      aria-label="Данные для записи"
    >
      <Stack>
        <TextInput
          aria-label="Имя"
          label="Имя"
          required
          value={body.guestName}
          error={errors.guestName}
          disabled={busy || unresolved}
          onChange={(event) => {
            const value = { ...body, guestName: event.currentTarget.value };
            setBody(value);
            saveBookingDraft(value);
          }}
        />
        <TextInput
          aria-label="Email"
          label="Email"
          required
          type="text"
          inputMode="email"
          value={body.guestEmail}
          error={errors.guestEmail}
          disabled={busy || unresolved}
          onChange={(event) => {
            const value = { ...body, guestEmail: event.currentTarget.value };
            setBody(value);
            saveBookingDraft(value);
          }}
        />
        {message && (
          <Alert role="alert" color="red">
            {message}
          </Alert>
        )}
        <Button type="submit" disabled={disabled || unresolved || busy} loading={busy}>
          {busy ? 'Записываем…' : 'Подтвердить запись'}
        </Button>
        {unresolved && (
          <Button onClick={() => void recover()} disabled={busy} variant="outline">
            Проверить результат подтверждения
          </Button>
        )}
      </Stack>
    </form>
  );
}
