export type ExpiringRequestCache<T> = {
  beginStore: () => (value: T) => T;
  clear: () => void;
  get: (load: () => Promise<T>) => Promise<T>;
  store: (value: T) => T;
};

export function createExpiringRequestCache<T>(ttlMilliseconds: number): ExpiringRequestCache<T> {
  const ttl = Math.max(0, ttlMilliseconds);
  let cached: { value: T; expiresAt: number } | null = null;
  let inFlight: { revision: number; promise: Promise<T> } | null = null;
  let revision = 0;

  const store = (value: T) => {
    revision += 1;
    cached = { value, expiresAt: Date.now() + ttl };
    inFlight = null;
    return value;
  };

  return {
    beginStore() {
      revision += 1;
      cached = null;
      inFlight = null;
      const storeRevision = revision;
      return (value) => {
        if (revision === storeRevision) {
          store(value);
        }
        return value;
      };
    },
    clear() {
      revision += 1;
      cached = null;
      inFlight = null;
    },
    get(load) {
      if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
      if (inFlight) return inFlight.promise;

      const requestRevision = revision;
      const request = load()
        .then((value) => {
          if (revision === requestRevision) {
            cached = { value, expiresAt: Date.now() + ttl };
          }
          return value;
        })
        .finally(() => {
          if (inFlight?.promise === request) inFlight = null;
        });
      inFlight = { revision: requestRevision, promise: request };
      return request;
    },
    store,
  };
}
