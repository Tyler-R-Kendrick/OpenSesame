/**
 * A stand-in for the service-worker globals the worker modules touch:
 * `caches`, `clients`, `registration`, the event listener table, and a fetch
 * that answers from a route table and records every URL it was asked for.
 *
 * Origin-wide `caches.match` throws on purpose: no production path may call
 * it (PWA-08), so a test that reaches it fails loudly instead of passing on a
 * lookup that would have crossed a release boundary.
 */

import { overlapCast } from "@opensesame/os-domain";

type Listener = (event: never) => void;

export type FakeClientInit = Readonly<{
  id: string;
  url: string;
  type?: string;
  controlled?: boolean;
}>;

export class FakeClient {
  readonly id: string;
  readonly url: string;
  readonly type: string;
  readonly frameType = "top-level";
  controlled: boolean;
  readonly messages: object[] = [];
  focused = 0;
  navigatedTo: string[] = [];

  constructor(init: FakeClientInit) {
    this.id = init.id;
    this.url = init.url;
    this.type = init.type ?? "window";
    this.controlled = init.controlled ?? true;
  }

  postMessage(message: object): void {
    this.messages.push(message);
  }

  async focus(): Promise<FakeClient> {
    this.focused += 1;
    return this;
  }

  async navigate(url: string): Promise<FakeClient> {
    this.navigatedTo.push(url);
    return this;
  }
}

export class FakeClients {
  readonly all: FakeClient[] = [];
  claimed = 0;
  readonly opened: string[] = [];

  add(init: FakeClientInit): FakeClient {
    const client = new FakeClient(init);
    this.all.push(client);
    return client;
  }

  remove(id: string): void {
    const index = this.all.findIndex((c) => c.id === id);
    if (index >= 0) this.all.splice(index, 1);
  }

  async matchAll(
    options: { type?: string; includeUncontrolled?: boolean } = {},
  ): Promise<FakeClient[]> {
    return this.all.filter(
      (c) =>
        (options.includeUncontrolled === true || c.controlled) &&
        (options.type === undefined ||
          options.type === "all" ||
          c.type === options.type),
    );
  }

  async get(id: string): Promise<FakeClient | undefined> {
    return this.all.find((c) => c.id === id);
  }

  async claim(): Promise<void> {
    this.claimed += 1;
    for (const c of this.all) c.controlled = true;
  }

  async openWindow(url: string): Promise<null> {
    this.opened.push(url);
    return null;
  }
}

function keyOf(request: string | Request): string {
  return request instanceof Request ? request.url : request;
}

export class FakeCache {
  readonly entries = new Map<string, Response>();

  constructor(private readonly env: FakeWorkerEnv) {}

  async match(request: string | Request): Promise<Response | undefined> {
    const hit = this.entries.get(keyOf(request));
    return hit?.clone();
  }

  async put(request: string | Request, response: Response): Promise<void> {
    if (this.env.quotaBytes !== null) {
      const size = (await response.clone().arrayBuffer()).byteLength;
      if (this.env.bytesStored + size > this.env.quotaBytes)
        throw new DOMException("quota", "QuotaExceededError");
      this.env.bytesStored += size;
    }
    this.entries.set(keyOf(request), response);
  }

  async add(request: string | Request): Promise<void> {
    const response = await this.env.fetch(request);
    if (!response.ok) throw new TypeError("add failed");
    await this.put(request, response);
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }

  async delete(request: string | Request): Promise<boolean> {
    return this.entries.delete(keyOf(request));
  }

  urls(): string[] {
    return [...this.entries.keys()].sort();
  }
}

export class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();
  readonly deleted: string[] = [];

  constructor(private readonly env: FakeWorkerEnv) {}

  async open(name: string): Promise<FakeCache> {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new FakeCache(this.env);
      this.stores.set(name, cache);
    }
    return cache;
  }

  async has(name: string): Promise<boolean> {
    return this.stores.has(name);
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async delete(name: string): Promise<boolean> {
    this.deleted.push(name);
    return this.stores.delete(name);
  }

  async match(): Promise<never> {
    throw new Error("origin-wide caches.match is forbidden (PWA-08)");
  }

  /** Seed a cache with URL → body pairs, as an earlier release would have. */
  async seed(
    name: string,
    entries: Readonly<Record<string, string>>,
  ): Promise<FakeCache> {
    const cache = await this.open(name);
    for (const [url, body] of Object.entries(entries))
      cache.entries.set(url, new Response(body, { status: 200 }));
    return cache;
  }
}

export type RouteAnswer = () => Response | Promise<Response>;

export class FakeWorkerEnv {
  readonly scope: string;
  readonly listeners = new Map<string, Listener[]>();
  readonly clients = new FakeClients();
  readonly cacheStorage: FakeCacheStorage;
  readonly routes = new Map<string, RouteAnswer>();
  readonly fetched: string[] = [];
  readonly notifications: { title: string; options: NotificationOptions }[] =
    [];
  skipWaitingCalls = 0;
  quotaBytes: number | null = null;
  bytesStored = 0;

  constructor(scope = "https://example.test/OpenSesame/") {
    this.scope = scope;
    this.cacheStorage = new FakeCacheStorage(this);
  }

  /** Register a same-origin file by scope-relative path. */
  serve(path: string, body: string, init: ResponseInit = {}): string {
    const url = new URL(path, this.scope).href;
    this.routes.set(url, () => new Response(body, { status: 200, ...init }));
    return url;
  }

  /** Make a path fail the way an offline fetch does. */
  offline(path: string): void {
    this.routes.set(new URL(path, this.scope).href, () => {
      throw new TypeError("Failed to fetch");
    });
  }

  readonly fetch = async (input: string | Request): Promise<Response> => {
    const url = keyOf(input);
    this.fetched.push(url);
    const route = this.routes.get(url);
    if (!route) return new Response("not found", { status: 404 });
    return route();
  };

  /** The `ServiceWorkerGlobalScope` handed to `installCoreWorker`. */
  get sw(): ServiceWorkerGlobalScope {
    const env = this;
    const scope = {
      registration: {
        scope: this.scope,
        showNotification: async (
          title: string,
          options: NotificationOptions,
        ) => {
          env.notifications.push({ title, options });
        },
      },
      clients: this.clients,
      location: new URL(this.scope),
      skipWaiting: async () => {
        env.skipWaitingCalls += 1;
      },
      addEventListener(type: string, listener: Listener) {
        const list = env.listeners.get(type) ?? [];
        list.push(listener);
        env.listeners.set(type, list);
      },
    };
    // SAFETY: the fake implements the members the worker modules touch; the
    // full ServiceWorkerGlobalScope surface is not needed by any handler.
    return overlapCast(scope);
  }

  listenerTypes(): string[] {
    return [...this.listeners.keys()].sort();
  }

  /** Dispatch an extendable event and await every `waitUntil` promise. */
  async dispatch(type: string, event: object): Promise<void> {
    const pending: Promise<void>[] = [];
    const extendable = {
      ...event,
      waitUntil: (promise: Promise<void>) => {
        pending.push(promise);
      },
    };
    // SAFETY: listeners are typed against the DOM event they handle; the fake
    // supplies the fields those handlers read.
    for (const listener of this.listeners.get(type) ?? [])
      listener(overlapCast(extendable));
    await Promise.all(pending);
  }

  async install(): Promise<void> {
    await this.dispatch("install", {});
  }

  async activate(): Promise<void> {
    await this.dispatch("activate", {});
  }

  /** Send a page message from `source` and settle the handlers. */
  async message(source: FakeClient | null, data: object): Promise<void> {
    await this.dispatch("message", { data, source });
  }

  /** Run the fetch handler for one request; `null` when it did not respond. */
  async fetchEvent(request: Request): Promise<Response | null> {
    let answer: Promise<Response> | null = null;
    await this.dispatch("fetch", {
      request,
      respondWith: (response: Promise<Response>) => {
        answer = response;
      },
    });
    return answer;
  }
}

export function navigateTo(url: string): Request {
  // SAFETY: Node's Request rejects `mode: "navigate"` in its constructor; the
  // handler only reads the property, so it is set on the instance afterwards.
  const request: { mode: string } = overlapCast(new Request(url));
  Object.defineProperty(request, "mode", { value: "navigate" });
  return overlapCast(request);
}
