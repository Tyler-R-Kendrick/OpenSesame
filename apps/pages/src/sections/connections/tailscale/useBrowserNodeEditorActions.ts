/** One editor attempt owns its original vault and node until it settles. */
import { localVaultSessionGuard } from "@opensesame/app-core/lib/secret-backends/local-vault-port.js";
import {
  type TailscaleBrowserNode,
  type TailscaleNodeConfiguration,
  normalizeTailscaleNodeIdentity,
  tailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import {
  configureBrowserNodeState,
  savedBrowserNodeConfiguration,
} from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { browserNodeTransportOptions } from "@opensesame/app-core/lib/tailscale/browser-node-transport-options.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NativeFieldValues } from "../connect/native-connector-ui.js";
import {
  nativeHTTPConfiguration,
  nativeHTTPDraft,
} from "./tailscale-native-http-values.js";
import {
  peerTLSConfiguration,
  peerTLSDraft,
} from "./tailscale-server-trust-values.js";
type Action = "save" | "start" | "forget";
type Editor = {
  ready: boolean;
  node: TailscaleBrowserNode | null;
  hostname: string;
  controlURL: string;
  authKey: string;
  nativeHTTPValues: NativeFieldValues;
  peerTLSValues: NativeFieldValues;
  setPeerTLSValues: (value: NativeFieldValues) => void;
  setFailure: (value: string) => void;
  setHasSaved: (value: boolean) => void;
  setHostname: (value: string) => void;
  setAuthKey: (value: string) => void;
  setNativeHTTPValues: (value: NativeFieldValues) => void;
  clearPeer: () => void;
};
async function saveConfiguration(
  configuration: TailscaleNodeConfiguration,
  node: TailscaleBrowserNode | null,
  check: () => void,
) {
  const owner = localVaultSessionGuard(vaultStore);
  const ownerCheck = () => {
    check();
    if (owner.current().guest)
      throw new Error(
        "Use an unlocked persistent vault to save browser node configuration.",
      );
  };
  try {
    ownerCheck();
    const saved = savedBrowserNodeConfiguration();
    if (
      JSON.stringify(saved?.nativeHTTP) !==
        JSON.stringify(configuration.nativeHTTP) ||
      JSON.stringify(saved?.peerTLS) !== JSON.stringify(configuration.peerTLS)
    )
      node?.stop();
    await configureBrowserNodeState(
      configuration,
      owner.current().tomb,
      ownerCheck,
    );
    ownerCheck();
  } finally {
    owner.close();
  }
}
async function perform(action: Action, editor: Editor, check: () => void) {
  if (action === "forget") {
    await editor.node?.forget();
    check();
    editor.setHasSaved(false);
    editor.setHostname(`opensesame-${crypto.randomUUID().slice(0, 12)}`);
    editor.setNativeHTTPValues(nativeHTTPDraft());
    editor.setPeerTLSValues(peerTLSDraft());
    return;
  }
  const identity = normalizeTailscaleNodeIdentity(editor);
  const nativeHTTP = nativeHTTPConfiguration(editor.nativeHTTPValues);
  const peerTLS = peerTLSConfiguration(editor.peerTLSValues);
  const configuration: TailscaleNodeConfiguration = {
    ...identity,
    ...browserNodeTransportOptions({ nativeHTTP, peerTLS }),
  };
  const saved = savedBrowserNodeConfiguration();
  if (
    saved &&
    (saved.hostname !== identity.hostname ||
      saved.controlURL !== identity.controlURL)
  )
    throw new Error(
      "Forget the saved browser node before changing its hostname or control server.",
    );
  if (
    action === "save" ||
    JSON.stringify(saved?.nativeHTTP) !== JSON.stringify(nativeHTTP) ||
    JSON.stringify(saved?.peerTLS) !== JSON.stringify(peerTLS)
  ) {
    await saveConfiguration(configuration, editor.node, check);
    check();
    editor.setHasSaved(true);
  }
  check();
  if (action === "start") {
    await editor.node?.start({ ...configuration, authKey: editor.authKey });
    check();
    editor.setHasSaved(true);
  }
}
export function useBrowserNodeEditorActions(editor: Editor) {
  const { ready, node, setAuthKey } = editor;
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useLayoutEffect(() => {
    generation.current++;
    pending.current = false;
    setBusy(false);
    if (!ready || node !== tailscaleBrowserNode()) setAuthKey("");
  }, [ready, node, setAuthKey]);
  async function run(action: Action) {
    if (!ready || pending.current || (action !== "save" && !node)) return;
    const turn = ++generation.current;
    const current = () =>
      generation.current === turn && tailscaleBrowserNode() === node;
    const check = () => {
      if (!current())
        throw new Error("The browser node owner changed. Try again.");
    };
    pending.current = true;
    setBusy(true);
    editor.setFailure("");
    editor.clearPeer();
    try {
      await perform(action, editor, check);
    } catch (error) {
      if (current())
        editor.setFailure(
          error instanceof Error
            ? error.message
            : "Browser node configuration failed.",
        );
    } finally {
      if (generation.current === turn) {
        pending.current = false;
        setBusy(false);
        setAuthKey("");
      }
    }
  }
  return {
    busy,
    save: () => {
      void run("save");
    },
    start: () => {
      void run("start");
    },
    forget: () => {
      void run("forget");
    },
  };
}
