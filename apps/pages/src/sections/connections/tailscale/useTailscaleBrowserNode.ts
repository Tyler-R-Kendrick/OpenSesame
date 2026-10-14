import {
  type TailscaleNodeSnapshot,
  subscribeTailscaleBrowserNode,
  tailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { savedBrowserNodeConfiguration } from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { useEffect, useState, useSyncExternalStore } from "react";
const idle: TailscaleNodeSnapshot = {
  status: "stopped",
  hostname: "",
  controlURL: "",
  authURL: "",
  addresses: [],
  peerCount: 0,
  failure: "",
};
const noSubscribe = () => () => {};
const idleSnapshot = () => idle;
export function useTailscaleBrowserNode(ready: boolean) {
  const node = useSyncExternalStore(
    subscribeTailscaleBrowserNode,
    tailscaleBrowserNode,
    () => null,
  );
  const state = useSyncExternalStore(
    node?.subscribe ?? noSubscribe,
    node?.snapshot ?? idleSnapshot,
    idleSnapshot,
  );
  const [hostname, setHostname] = useState(
    () => `opensesame-${crypto.randomUUID().slice(0, 12)}`,
  );
  const [controlURL, setControlURL] = useState(
    "https://controlplane.tailscale.com",
  );
  const [authKey, setAuthKey] = useState("");
  const [failure, setFailure] = useState("");
  const [peerURL, setPeerURL] = useState("");
  const [probe, setProbe] = useState("");
  const [hasSaved, setHasSaved] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const saved = savedBrowserNodeConfiguration();
    setHasSaved(!!saved);
    if (saved) {
      setHostname(saved.hostname);
      setControlURL(saved.controlURL);
    }
  }, [ready]);
  useEffect(() => {
    if (state.status === "stopped" || state.status === "error") {
      setAuthKey("");
      setProbe("");
    }
  }, [state.status]);
  return {
    node,
    state,
    hostname,
    setHostname,
    controlURL,
    setControlURL,
    authKey,
    setAuthKey,
    failure,
    peerURL,
    setPeerURL,
    probe,
    hasSaved,
    active: state.status !== "stopped" && state.status !== "error",
    start: () => {
      setFailure("");
      setProbe("");
      void node
        ?.start({ hostname, controlURL, authKey })
        .then(() => setHasSaved(true))
        .catch((error: Error) => setFailure(error.message))
        .finally(() => setAuthKey(""));
    },
    forget: () => {
      setFailure("");
      void node
        ?.forget()
        .then(() => {
          setHasSaved(false);
          setHostname(`opensesame-${crypto.randomUUID().slice(0, 12)}`);
        })
        .catch((error: Error) => setFailure(error.message));
    },
    testPeer: () => {
      setProbe("");
      void node
        ?.get(peerURL)
        .then((value) =>
          setProbe(
            `HTTP ${value.status} · ${value.text.length} characters received through Tailscale`,
          ),
        )
        .catch((error: Error) => setFailure(error.message));
    },
  };
}
export type BrowserNodeEditor = ReturnType<typeof useTailscaleBrowserNode>;
