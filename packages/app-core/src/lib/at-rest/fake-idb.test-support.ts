/**
 * Just enough IndexedDB for the at-rest suites: databases of object stores
 * keyed by `id`, one optional index, `add` that refuses a present key, and
 * every row readable raw — so a test can see exactly what reached disk.
 */
import {
  type BoundaryObject,
  type BoundaryValue,
  overlapCast,
} from "@opensesame/os-domain";

type FakeStore = {
  rows: Map<string, BoundaryObject>;
  indexes: Map<string, string>;
};

export type FakeDatabases = Map<string, Map<string, FakeStore>>;

type FakeRequest = {
  result?: BoundaryValue;
  error?: BoundaryValue;
  onsuccess?: () => void;
  onerror?: () => void;
  onupgradeneeded?: () => void;
};

function request(run: () => BoundaryValue): IDBRequest {
  const req: FakeRequest = {};
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

function rowId(row: BoundaryObject): string {
  return String(row.id);
}

function objectStore(store: FakeStore) {
  return {
    get: (id: string) => request(() => store.rows.get(id)),
    getAll: () => request(() => [...store.rows.values()]),
    put: (row: BoundaryObject) =>
      request(() => {
        store.rows.set(rowId(row), row);
        return row.id;
      }),
    add: (row: BoundaryObject) =>
      request(() => {
        if (store.rows.has(rowId(row))) {
          throw new DOMException("present", "ConstraintError");
        }
        store.rows.set(rowId(row), row);
        return row.id;
      }),
    delete: (id: string) => request(() => store.rows.delete(id)),
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

export type FakeIndexedDb = { factory: IDBFactory; databases: FakeDatabases };

/** A factory over `databases`, which the test keeps to read rows raw. */
export function fakeIndexedDb(
  databases: FakeDatabases = new Map(),
): FakeIndexedDb {
  const factory = {
    open(name: string) {
      const req: FakeRequest = {};
      queueMicrotask(() => {
        const fresh = !databases.has(name);
        const stores = databases.get(name) ?? new Map<string, FakeStore>();
        databases.set(name, stores);
        req.result = overlapCast(database(stores));
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
): BoundaryObject[] {
  return [...(databases.get(name)?.get(store)?.rows.values() ?? [])];
}
