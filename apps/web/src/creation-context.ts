import type { CreateEventType } from '@calendar/api-client';

const storageName = 'owner-event-type-operation';
const cookieName = 'owner_event_type_operation';
export type CreationContext = { key: string; fingerprint: string; parameters?: CreateEventType };
// Only unsent drafts live here. Routing through login preserves them; reload discards them.
export const typeDraft = { name: '', description: '', duration: '30' };
export function resetDraft() {
  Object.assign(typeDraft, { name: '', description: '', duration: '30' });
}
export async function fingerprint(parameters: CreateEventType) {
  const canonical = JSON.stringify([
    parameters.name.trim(),
    parameters.description ?? '',
    parameters.durationMinutes,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function stores() {
  return [() => window.localStorage, () => window.sessionStorage];
}
export function loadCreationContext(): CreationContext | undefined {
  for (const storage of stores()) {
    try {
      const value = storage().getItem(storageName);
      if (value) return JSON.parse(value) as CreationContext;
    } catch {
      /* Try the next storage. */
    }
  }
  try {
    const value = document.cookie
      .split('; ')
      .find((item) => item.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (value) return JSON.parse(decodeURIComponent(value)) as CreationContext;
  } catch {
    /* No recoverable context. */
  }
  return undefined;
}
export function persistCreation(context: CreationContext) {
  const value = JSON.stringify(context);
  for (const storage of stores()) {
    try {
      storage().setItem(storageName, value);
      if (storage().getItem(storageName) === value) return true;
    } catch {
      /* Cookie stores only key and fingerprint, never form contents. */
    }
  }
  const cookie = encodeURIComponent(
    JSON.stringify({ key: context.key, fingerprint: context.fingerprint }),
  );
  try {
    document.cookie = `${cookieName}=${cookie}; Path=/; SameSite=Lax; Max-Age=31536000${location.protocol === 'https:' ? '; Secure' : ''}`;
    return document.cookie.split('; ').includes(`${cookieName}=${cookie}`);
  } catch {
    return false;
  }
}
export function clearCreation() {
  for (const storage of stores()) {
    try {
      storage().removeItem(storageName);
    } catch {
      /* May have become unavailable. */
    }
  }
  try {
    document.cookie = `${cookieName}=; Path=/; SameSite=Lax; Max-Age=0${location.protocol === 'https:' ? '; Secure' : ''}`;
  } catch {
    /* May have become unavailable. */
  }
}
