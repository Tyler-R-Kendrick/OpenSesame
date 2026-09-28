/**
 * Just enough IndexedDB for the at-rest suites: databases of object stores
 * keyed by `id`, one optional index, `add` that refuses a present key, and
 * every row readable raw — so a test can see exactly what reached disk.
 */
import { overlapCast } from "@opensesame/os-domain";

type Row = Record<string, unknown>;

type FakeStore = { rows: Map<string, Row>; indexes: Map<string, string> };

export type FakeDatabases = Map<string, Map<string, FakeStore>>;

function request<T>(run: () => T): IDBRequest<T> {
  const req: {
    result?: T;
    error?: DOMException;
    onsuccess?: () => void;
    onerror?: () => void;
  } = {};
  queueMicrotask(() => {
    try {
      req.result = run();
      req.onsuccess?.();
    } catch (error) {
      req.error = overlapCast(error);
      req.onerror?.();
    }
  });
  return overlapCast(req);
}

function objectStore(store: FakeStore) {
  return {
    get: (id: string) => request(() => store.rows.get(id)),
    getAll: () => request(() => [...store.rows.values()]),
    put: (row: Row) =>
      request(() => {
        store.rows.set(String(row.id), row);
      }),
    add: (row: Row) =>
      request(() => {
        if (store.rows.has(String(row.id))) {
          throw new DOMException("present", "ConstraintError");
        }
        store.rows.set(String(row.id), row);
      }),
    delete: (id: string) =>
      request(() => {
        store.rows.delete(id);
      }),
    index: (name: string) => ({
      getAll: (value: string) =>
        request(() =>
          [...store.rows.values()].filter(
            (row) => row[store.indexes.get(name) ?? ""] === value,
          ),
        ),
    }),
    createIndex: (name: string, keyPath: string) => {
      store.indexes.set(name, keyPath);
    },
  };
}

function database(stores: Map<string, FakeStore>) {
  return {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore(name: string) {
      const store: FakeStore = { rows: new Map(), indexes: new Map() };
      stores.set(name, store);
      return objectStore(store);
    },
    transaction: () => ({
      objectStore: (name: string) => {
        const store = stores.get(name);
        if (!store) throw new DOMException("no store", "NotFoundError");
        return objectStore(store);
      },
    }),
    close() {},
  };
}

/** A factory over `databases`, which the test keeps to read rows raw. */
export function fakeIndexedDb(databases: FakeDatabases = new Map()): {
  factory: IDBFactory;
  databases: FakeDatabases;
} {
  const factory = {
    open(name: string) {
      const req: {
        result?: ReturnType<typeof database>;
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
        onerror?: () => void;
      } = {};
      queueMicrotask(() => {
        const fresh = !databases.has(name);
        const stores = databases.get(name) ?? new Map<string, FakeStore>();
        databases.set(name, stores);
        req.result = database(stores);
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { factory: overlapCast(factory), databases };
}

/** Every row of one store, as it rests. */
export function rawRows(
  databases: FakeDatabases,
  name: string,
  store: string,
): Row[] {
  return [...(databases.get(name)?.get(store)?.rows.values() ?? [])];
}
