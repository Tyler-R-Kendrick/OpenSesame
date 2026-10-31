/**
 * The hosts the bridge may reach (ADR 0199). A page asks for a host it needs;
 * the bridge only records the ask. Reaching a host is allowed once the person
 * has granted the browser permission for it in the popup, and never for a host
 * the table does not name. Granting is the browser's own prompt, so what is
 * held is read back from the browser, not from a list this keeps.
 */
import {
  type BridgeTable,
  isNamedHost,
  providersOfHost,
} from "@opensesame/connector-bridge";
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import type { BridgePorts } from "./ports.js";

export const PENDING_KEY = "bridgePending";
const MAX_PENDING = 64;

export function createHostBook(ports: BridgePorts, table: BridgeTable) {
  const named = { has: (host: string) => isNamedHost(table, host) };

  /** The hosts the person allowed: held by the browser and named by the table. */
  async function granted(): Promise<string[]> {
    return (await ports.heldHosts()).filter((host) => named.has(host)).sort();
  }

  async function readPending(): Promise<string[]> {
    const raw = await ports.asks.get(PENDING_KEY);
    if (raw === undefined) return [];
    try {
      const parsed: BoundaryValue = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.flatMap((host) =>
            isString(host) && named.has(host) ? [host] : [],
          )
        : [];
    } catch {
      return [];
    }
  }

  /** What a page has asked for and a person has not yet answered. */
  async function pending(): Promise<string[]> {
    const held = new Set(await granted());
    return (await readPending()).filter((host) => !held.has(host));
  }

  async function show(): Promise<void> {
    const count = (await pending()).length;
    await ports.setBadge(count ? String(count) : "");
  }

  /** Record a page's ask for hosts the table names; others are dropped, not remembered. */
  async function ask(hosts: readonly string[]): Promise<string[]> {
    const wanted = hosts.filter((host) => named.has(host));
    const next = [...new Set([...(await readPending()), ...wanted])].slice(
      0,
      MAX_PENDING,
    );
    await ports.asks.set(PENDING_KEY, JSON.stringify(next));
    await show();
    return pending();
  }

  let bare = "";

  /**
   * Requests to a granted host go out without an `Origin` header; the rule
   * follows the grant. Applied again whenever the set differs from the one
   * this worker last applied, which is also the first time it runs, since the
   * browser may have dropped its session rules since.
   */
  async function readyToSend(): Promise<string[]> {
    const hosts = await granted();
    const key = hosts.join(",");
    if (key !== bare) {
      await ports.setBareHosts(hosts);
      bare = key;
    }
    return hosts;
  }

  /** The browser's grant changed: retire the asks it answered. */
  async function reconcile(): Promise<void> {
    await ports.asks.set(PENDING_KEY, JSON.stringify(await pending()));
    await show();
    await readyToSend();
  }

  async function revoke(host: string): Promise<void> {
    if (named.has(host) && (await ports.hasHost(host)))
      await ports.removeHost(host);
    await reconcile();
  }

  /** Providers the table lets be called at this host, for the popup to name. */
  function providersOf(host: string): string[] {
    return providersOfHost(table, host);
  }

  return { granted, readyToSend, pending, ask, reconcile, revoke, providersOf };
}

export type HostBook = ReturnType<typeof createHostBook>;
