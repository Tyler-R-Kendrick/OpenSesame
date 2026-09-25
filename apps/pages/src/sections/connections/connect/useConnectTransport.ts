import { connectRelayConfigured } from "@opensesame/app-core/lib/vercel-connect-relay.js";
import {
  subscribeVercelConnectAuth,
  vercelConnectAuth,
} from "@opensesame/app-core/lib/vercel-connect.js";
import { useSyncExternalStore } from "react";

export type ConnectTransport = {
  /** This deployment serves the Connect relay. */
  relay: boolean;
  /** Create, edit and authorize connectors from this session. */
  canManage: boolean;
  /** Acquire a token to prove it (relay only: the page never holds one). */
  canProve: boolean;
};

function snapshot(): string {
  const auth = vercelConnectAuth();
  return [
    connectRelayConfigured() ? "relay" : "",
    auth?.manageKey ? "key" : "",
    auth?.token ? "token" : "",
  ].join("|");
}

export function useConnectTransport(): ConnectTransport {
  const state = useSyncExternalStore(
    subscribeVercelConnectAuth,
    snapshot,
    snapshot,
  );
  const relay = state.startsWith("relay");
  const key = state.includes("|key");
  const token = state.endsWith("token");
  return {
    relay,
    canManage: relay ? key : token,
    canProve: relay && key,
  };
}
