import {
  type TailscaleBrowserNode,
  type TailscaleNodeSnapshot,
  subscribeTailscaleBrowserNode,
  tailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { savedBrowserNodeConfiguration } from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
/** A service result belongs only to its current URL, request and connected node. */
function useTailscalePeerProbe(node: TailscaleBrowserNode | null) {
  const [peerURL, setURL] = useState("");
  const [probe, setProbe] = useState("");
  const [failure, setFailure] = useState("");
  const generation = useRef(0);
  const clear = useCallback(() => {
    generation.current++;
    setProbe("");
    setFailure("");
  }, []);
  useEffect(() => {
    const releaseNode = node?.subscribe(() => {
      if (node.snapshot().status !== "connected") clear();
    });
    const releasePort = subscribeTailscaleBrowserNode(() => {
      if (tailscaleBrowserNode() !== node) clear();
    });
    return () => {
      releaseNode?.();
      releasePort();
      generation.current++;
    };
  }, [node, clear]);
  async function test() {
    clear();
    const turn = generation.current;
    const current = () =>
      node?.snapshot().status === "connected" &&
      tailscaleBrowserNode() === node &&
      generation.current === turn;
    if (!node || !current()) return;
    try {
      const value = await node.get(peerURL);
      if (!current()) return;
      if (value.status >= 200 && value.status < 300)
        setProbe(
          `HTTP ${value.status} · ${value.text.length} characters received through Tailscale`,
        );
      else setFailure(`Tailnet service returned HTTP ${value.status}.`);
    } catch {
      if (current())
        setFailure(
          "The tailnet service request failed. Check the address and try again.",
        );
    }
  }
  return {
    peerURL,
    probe,
    failure,
    clear,
    setPeerURL: (value: string) => {
      clear();
      setURL(value);
    },
    testPeer: () => {
      void test();
    },
  };
}
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
  const peer = useTailscalePeerProbe(node);
  const [hasSaved, setHasSaved] = useState(false);
  // Restore public fields before Connect becomes interactable.
  useLayoutEffect(() => {
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
    probeFailure: peer.failure,
    peerURL: peer.peerURL,
    setPeerURL: peer.setPeerURL,
    probe: peer.probe,
    hasSaved,
    active: state.status !== "stopped" && state.status !== "error",
    start: () => {
      setFailure("");
      peer.clear();
      void node
        ?.start({ hostname, controlURL, authKey })
        .then(() => setHasSaved(true))
        .catch((error: Error) => setFailure(error.message))
        .finally(() => setAuthKey(""));
    },
    forget: () => {
      setFailure("");
      peer.clear();
      void node
        ?.forget()
        .then(() => {
          setHasSaved(false);
          setHostname(`opensesame-${crypto.randomUUID().slice(0, 12)}`);
        })
        .catch((error: Error) => setFailure(error.message));
    },
    testPeer: () => {
      setFailure("");
      peer.testPeer();
    },
  };
}
export type BrowserNodeEditor = ReturnType<typeof useTailscaleBrowserNode>;
