import { isBridgeHost } from "@opensesame/connector-bridge";
/**
 * What the popup may ask the background (ADR 0199). Decoded here; a message
 * that does not decode is answered `bad_message`. Granting a host is the
 * popup's own `permissions.request`, made on the person's click; the
 * background only reads the browser's answer back.
 */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type { Bridge, SenderFacts } from "./bridge.js";
import { webOrigin } from "./sites.js";

export const POPUP_MESSAGE = "opensesame.bridge.popup";

export type PopupAction =
  | { action: "status"; origin: string | null }
  | { action: "enable"; origin: string }
  | { action: "disable"; origin: string }
  | { action: "granted" }
  | { action: "revoke"; host: string };

export type HostRow = { host: string; providers: string[] };
export type PopupStatus = {
  origin: string | null;
  enabled: boolean;
  pending: HostRow[];
  granted: HostRow[];
};
export type PopupReply =
  | { status: PopupStatus }
  | {
      outcome: "enabled" | "invalid_origin" | "permission_not_granted" | "done";
    }
  | { error: "bad_message" | "forbidden_sender" };

export function parsePopupMessage(message: BoundaryValue): PopupAction | null {
  if (!isJsonObject(message) || message.type !== POPUP_MESSAGE) return null;
  const { action } = message;
  if (action === "granted") return { action };
  if (action === "revoke")
    return isBridgeHost(message.host) ? { action, host: message.host } : null;
  if (action === "status") {
    const origin = isString(message.origin) ? webOrigin(message.origin) : null;
    return { action, origin };
  }
  if (action === "enable" || action === "disable") {
    const origin = isString(message.origin) ? webOrigin(message.origin) : null;
    return origin ? { action, origin } : null;
  }
  return null;
}

function rows(bridge: Bridge, hosts: readonly string[]): HostRow[] {
  return hosts.map((host) => ({
    host,
    providers: bridge.hosts.providersOf(host),
  }));
}

export async function handlePopup(
  bridge: Bridge,
  action: PopupAction,
  sender: SenderFacts,
): Promise<PopupReply> {
  if (!bridge.fromPopup(sender)) return { error: "forbidden_sender" };
  if (action.action === "status") {
    const [granted, pending] = await Promise.all([
      bridge.hosts.granted(),
      bridge.hosts.pending(),
    ]);
    return {
      status: {
        origin: action.origin,
        enabled: action.origin
          ? await bridge.sites.isEnabled(action.origin)
          : false,
        pending: rows(bridge, pending),
        granted: rows(bridge, granted),
      },
    };
  }
  if (action.action === "enable")
    return { outcome: await bridge.sites.enable(action.origin) };
  if (action.action === "disable") {
    await bridge.sites.disable(action.origin);
    return { outcome: "done" };
  }
  if (action.action === "revoke") await bridge.hosts.revoke(action.host);
  else await bridge.hosts.reconcile();
  return { outcome: "done" };
}
