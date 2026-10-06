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
  transaction?: { abort: () => void };
};

function request(
  run: () => BoundaryValue,
  after?: (failed: boolean) => void,
): IDBRequest {
  const req: FakeRequest = {};
  queueMicrotask(() => {
    let failed = false;
    try {
      req.result = run();
      req.onsuccess?.();
    } catch (error) {
      failed = true;
      req.error = overlapCast(error);
      req.onerror?.();
    }
    after?.(failed);
  });
  return overlapCast(req);
}

function rowId(row: BoundaryObject): string {
  return String(row.id);
}

function objectStore(
  store: FakeStore,
  tracked: (run: () => BoundaryValue) => IDBRequest = request,
) {
  return {
    get: (id: string) => tracked(() => store.rows.get(id)),
    getAll: () => tracked(() => [...store.rows.values()]),
    put: (row: BoundaryObject) =>
      tracked(() => {
        store.rows.set(rowId(row), row);
        return row.id;
      }),
    add: (row: BoundaryObject) =>
      tracked(() => {
        if (store.rows.has(rowId(row))) {
          throw new DOMException("present", "ConstraintError");
        }
        store.rows.set(rowId(row), row);
        return row.id;
      }),
    delete: (id: string) => tracked(() => store.rows.delete(id)),
    index: (name: string) => ({
      getAll: (value: string) =>
        tracked(() =>
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
    transaction: () => countingTransaction(stores),
    close() {},
  };
}

type FakeTransaction = {
  oncomplete: (() => void) | undefined;
  onabort: (() => void) | undefined;
  onerror: (() => void) | undefined;
  error: BoundaryValue | undefined;
  objectStore(name: string): ReturnType<typeof objectStore>;
};

/** Completes after this turn's requests, on the same object the caller holds. */
function countingTransaction(stores: Map<string, FakeStore>) {
  let pending = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    queueMicrotask(() => {
      tx.oncomplete?.();
    });
  };
  const tracked = (run: () => BoundaryValue): IDBRequest => {
    pending += 1;
    return request(run, (failed) => {
      pending -= 1;
      if (failed) {
        finished = true;
        return;
      }
      if (pending === 0) finish();
    });
  };
  const tx: FakeTransaction = {
    oncomplete: undefined,
    onabort: undefined,
    onerror: undefined,
    error: undefined,
    objectStore(name: string) {
      const store = stores.get(name);
      if (!store) throw new DOMException("no store", "NotFoundError");
      return objectStore(store, tracked);
    },
  };
  queueMicrotask(() => {
    if (pending === 0) finish();
  });
  return tx;
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
        let aborted = false;
        if (fresh) {
          req.transaction = {
            abort: () => {
              aborted = true;
            },
          };
          req.onupgradeneeded?.();
        }
        if (aborted) {
          databases.delete(name);
          req.error = "IndexedDB upgrade aborted";
          req.onerror?.();
        } else req.onsuccess?.();
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
