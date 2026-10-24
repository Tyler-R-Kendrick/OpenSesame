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
import {
  nativeHTTPDraft,
  nextNativeHTTPDraft,
} from "./tailscale-native-http-values.js";
import {
  nextPeerTLSDraft,
  peerTLSDraft,
} from "./tailscale-server-trust-values.js";
import { useBrowserNodeEditorActions } from "./useBrowserNodeEditorActions.js";
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
  const [nativeHTTPValues, setNativeHTTPValues] = useState(nativeHTTPDraft);
  const [peerTLSValues, setPeerTLSValues] = useState(peerTLSDraft);
  // Public metadata restores when ready; later runtime binding must preserve edits.
  useLayoutEffect(() => {
    if (!ready) return;
    const saved = savedBrowserNodeConfiguration();
    setHasSaved(!!saved);
    setNativeHTTPValues(nativeHTTPDraft(saved?.nativeHTTP));
    setPeerTLSValues(peerTLSDraft(saved?.peerTLS));
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
  const actions = useBrowserNodeEditorActions({
    ready,
    node,
    hostname,
    controlURL,
    authKey,
    nativeHTTPValues,
    peerTLSValues,
    setPeerTLSValues,
    setFailure,
    setHasSaved,
    setHostname,
    setAuthKey,
    setNativeHTTPValues,
    clearPeer: peer.clear,
  });
  return {
    ready,
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
    ...actions,
    peerTLSValues,
    setPeerTLSValue: (id: string, value: string) => {
      peer.clear();
      setPeerTLSValues((values) => nextPeerTLSDraft(values, id, value));
    },
    nativeHTTPValues,
    setNativeHTTPValue: (id: string, value: string) =>
      setNativeHTTPValues((values) => nextNativeHTTPDraft(values, id, value)),
    testPeer: () => {
      setFailure("");
      peer.testPeer();
    },
  };
}
export type BrowserNodeEditor = ReturnType<typeof useTailscaleBrowserNode>;
