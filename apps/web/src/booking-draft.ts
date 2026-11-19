import { operationStorage } from './operation-storage';
import type { ConfirmBooking } from '@calendar/api-client';
export type ConfirmationContext = {
  key: string;
  fingerprint: string;
  holdId: string;
  bookingId?: string;
  body?: ConfirmBooking;
};
export const confirmationStorage = () =>
  operationStorage<ConfirmationContext>(
    'guest-confirmation',
    'guest_confirmation',
    ({ key, fingerprint, holdId, bookingId }) => ({ key, fingerprint, holdId, bookingId }),
  );
const draftKey = 'guest-booking-draft';
let memory: ConfirmBooking = { guestName: '', guestEmail: '' };
export function loadBookingDraft() {
  for (const storage of [() => localStorage, () => sessionStorage])
    try {
      const value = storage().getItem(draftKey);
      if (value) return JSON.parse(value) as ConfirmBooking;
    } catch {
      /* Next available store. */
    }
  return memory;
}
export function saveBookingDraft(body: ConfirmBooking) {
  memory = body;
  for (const storage of [() => localStorage, () => sessionStorage])
    try {
      storage().setItem(draftKey, JSON.stringify(body));
      if (storage().getItem(draftKey) === JSON.stringify(body)) return;
    } catch {
      /* Form is never put in a cookie. */
    }
}
export function clearBookingDraft() {
  memory = { guestName: '', guestEmail: '' };
  for (const storage of [() => localStorage, () => sessionStorage])
    try {
      storage().removeItem(draftKey);
    } catch {
      /* Store unavailable. */
    }
}
