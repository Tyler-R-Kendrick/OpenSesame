/**
 * What the bridge needs from the browser, as ports the logic is written
 * against and the tests replace. Nothing under `lib/` touches `browser.*`
 * except `browser-ports.ts`, which implements these.
 */
import type { HeaderPair } from "@opensesame/connector-bridge";

export interface KeyValueStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface FetchInit {
  method: string;
  headers: readonly HeaderPair[];
  body: string | null;
  signal: AbortSignal;
}

export interface BridgePorts {
  readonly store: KeyValueStore;
  /** In-memory only (cleared when the browser closes): the hosts a page asked for, which can name a person's own tenant. */
  readonly asks: KeyValueStore;
  /** This extension's id, which a relayed message must carry. */
  readonly extensionId: string;
  /** Whether the browser holds permission for `https://<host>/*`. */
  hasHost(host: string): Promise<boolean>;
  removeHost(host: string): Promise<void>;
  /** Every `https://<host>/*` pattern the extension holds, as hosts. */
  heldHosts(): Promise<readonly string[]>;
  hasOrigin(origin: string): Promise<boolean>;
  removeOrigin(origin: string): Promise<void>;
  registeredIds(): Promise<readonly string[]>;
  /** Register the relay for `origin`, top frame only, under `id`. */
  register(id: string, origin: string): Promise<void>;
  unregister(id: string): Promise<void>;
  /** One request, with the extension's own fetch: no cookies, no redirects. */
  fetch(url: URL, init: FetchInit): Promise<Response>;
  setBadge(text: string): Promise<void>;
  /**
   * Requests this extension itself sends to exactly these hosts leave without
   * an `Origin` header, as a plain HTTP client's would. A browser adds the
   * extension's own origin to a POST, and a few providers answer an origin they
   * do not know with an error instead of the 401 a bad key should get. Replaces
   * the previous set; an empty set removes the rule.
   */
  setBareHosts(hosts: readonly string[]): Promise<void>;
}
