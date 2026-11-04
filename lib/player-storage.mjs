// Scope the browser APIs the Ink bridge actually uses, before importing glue.
export function scopedLocalStorage(storage, prefix) {
  const keys = () => Array.from({ length: storage.length }, (_, i) => storage.key(i))
    .filter((key) => key?.startsWith(prefix));
  const api = {
    get length() { return keys().length; },
    key: (i) => keys()[i]?.slice(prefix.length) ?? null,
    getItem: (key) => storage.getItem(prefix + key),
    setItem: (key, value) => storage.setItem(prefix + key, String(value)),
    removeItem: (key) => storage.removeItem(prefix + key),
    clear: () => { for (const key of keys()) storage.removeItem(key); },
  };
  return new Proxy(api, {
    get: (target, key) => key in target || typeof key === 'symbol' ? target[key] : api.getItem(key) ?? undefined,
    set: (_target, key, value) => { api.setItem(key, value); return true; },
    deleteProperty: (_target, key) => { api.removeItem(key); return true; },
    ownKeys: () => keys().map((key) => key.slice(prefix.length)),
    getOwnPropertyDescriptor: (_target, key) => api.getItem(key) === null ? undefined
      : { configurable: true, enumerable: true, writable: true, value: api.getItem(key) },
  });
}

export function scopedDirectory(getRoot, namespace) {
  return async () => (await getRoot()).getDirectoryHandle(namespace, { create: true });
}

export async function clearDirectory(directory) {
  for await (const name of directory.keys()) await directory.removeEntry(name, { recursive: true });
}

export function installPlayerStorage(window, namespace) {
  const local = scopedLocalStorage(window.localStorage, `${namespace}:`);
  Object.defineProperty(window, 'localStorage', { configurable: true, value: local });
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: scopedLocalStorage(window.sessionStorage, `${namespace}:`) });
  const getRoot = window.navigator.storage.getDirectory.bind(window.navigator.storage);
  const getDirectory = scopedDirectory(getRoot, namespace);
  Object.defineProperty(window.navigator.storage, 'getDirectory', { configurable: true, value: getDirectory });
  return { namespace, localStorage: local, getDirectory,
    clearCache: async () => clearDirectory(await getDirectory()) };
}
