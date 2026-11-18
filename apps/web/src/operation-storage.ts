export function operationStorage<Context extends { key: string; fingerprint: string }>(
  storageName: string,
  cookieName: string,
  technicalContext: (context: Context) => object = ({ key, fingerprint }) => ({ key, fingerprint }),
) {
  function stores() {
    return [() => window.localStorage, () => window.sessionStorage];
  }
  function load(): Context | undefined {
    for (const storage of stores()) {
      try {
        const value = storage().getItem(storageName);
        if (value) return JSON.parse(value) as Context;
      } catch {
        /* Try the next storage. */
      }
    }
    try {
      const value = document.cookie
        .split('; ')
        .find((item) => item.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      if (value) return JSON.parse(decodeURIComponent(value)) as Context;
    } catch {
      /* No recoverable context. */
    }
    return undefined;
  }
  function persist(context: Context) {
    const value = JSON.stringify(context);
    for (const storage of stores()) {
      try {
        storage().setItem(storageName, value);
        if (storage().getItem(storageName) === value) return true;
      } catch {
        /* Cookie stores only key and fingerprint, never form contents. */
      }
    }
    const cookie = encodeURIComponent(JSON.stringify(technicalContext(context)));
    try {
      document.cookie = `${cookieName}=${cookie}; Path=/; SameSite=Lax; Max-Age=31536000${location.protocol === 'https:' ? '; Secure' : ''}`;
      return document.cookie.split('; ').includes(`${cookieName}=${cookie}`);
    } catch {
      return false;
    }
  }
  function clear() {
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

  return { load, persist, clear };
}
