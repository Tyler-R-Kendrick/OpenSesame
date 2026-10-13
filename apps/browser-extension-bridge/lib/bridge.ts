/**
 * The bridge's decisions (ADR 0199). A message from a page's relay is answered
 * only when the browser says it came from this extension's own relay, in the
 * top frame of a tab at an origin a person switched on. A message from the
 * popup is answered only when it came from an extension page, not a tab.
 * Everything a page may ask is decoded by `@opensesame/connector-bridge` first.
 */
import {
  type BridgeFetchResponse,
  type BridgeTable,
  type PageReply,
  type PageRequest,
  checkFetch,
} from "@opensesame/connector-bridge";
import { forward } from "./forward.js";
import { createHostBook } from "./hosts.js";
import type { BridgePorts } from "./ports.js";
import { createSiteRegistry, webOrigin } from "./sites.js";

/** What the browser says about who sent a message, reduced to the facts this decides on. */
export type SenderFacts = {
  id: string | undefined;
  tabId: number | undefined;
  frameId: number | undefined;
  url: string | undefined;
};

export function createBridge(
  ports: BridgePorts,
  table: BridgeTable,
  version: string,
) {
  const sites = createSiteRegistry(ports);
  const hosts = createHostBook(ports, table);

  async function admitted(sender: SenderFacts): Promise<boolean> {
    if (
      sender.id !== ports.extensionId ||
      sender.tabId === undefined ||
      sender.frameId !== 0
    )
      return false;
    const origin = sender.url ? webOrigin(sender.url) : null;
    return origin !== null && (await sites.isEnabled(origin));
  }

  async function fetchFor(
    request: Extract<PageRequest, { op: "fetch" }>,
  ): Promise<PageReply> {
    const granted = new Set(await hosts.readyToSend());
    const verdict = checkFetch(request.request, table, granted);
    if (!verdict.ok) return { id: request.id, error: verdict.code };
    const sent = await forward(
      ports,
      verdict.url,
      request.request,
      verdict.headers,
    );
    return sent.ok
      ? { id: request.id, result: sent.response satisfies BridgeFetchResponse }
      : { id: request.id, error: sent.code };
  }

  /** A page's request, relayed by the content script. */
  async function relay(
    request: PageRequest,
    sender: SenderFacts,
  ): Promise<PageReply> {
    if (!(await admitted(sender)))
      return { id: request.id, error: "not_enabled" };
    if (request.op === "hello")
      return {
        id: request.id,
        result: {
          bridge: "opensesame-connector-bridge",
          version,
          granted: await hosts.granted(),
        },
      };
    if (request.op === "need")
      return {
        id: request.id,
        result: { pending: await hosts.ask(request.hosts) },
      };
    return fetchFor(request);
  }

  /** The popup is an extension page: no tab, this extension's id. */
  function fromPopup(sender: SenderFacts): boolean {
    return sender.id === ports.extensionId && sender.tabId === undefined;
  }

  return { relay, fromPopup, sites, hosts };
}

export type Bridge = ReturnType<typeof createBridge>;
