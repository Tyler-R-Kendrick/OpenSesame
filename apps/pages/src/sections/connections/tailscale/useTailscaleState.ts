import type { TailscaleKeyHandoff } from "@opensesame/app-core/lib/tailscale/artifacts.js";
import {
  type TailscaleAppConfiguration,
  type TailscaleProvisionedKey,
  tailscaleAppName,
} from "@opensesame/app-core/lib/tailscale/oauth-app.js";
import type { SavedTailscaleApp } from "@opensesame/app-core/lib/tailscale/store.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { tailscaleAppDependencies as deps } from "./tailscale-dependencies.js";
import { useTailscaleCredentialLifetime } from "./useTailscaleCredentialLifetime.js";
function useTailscaleFields() {
  const [saved, setSaved] = useState<SavedTailscaleApp | null>(null);
  const [draft, setDraft] = useState<
    Pick<TailscaleAppConfiguration, "apiBase" | "tailnet" | "name"> & {
      allowedNodeAttributes: string[];
    }
  >(() => ({
    apiBase: "https://api.tailscale.com/",
    tailnet: "-",
    name: tailscaleAppName(),
    allowedNodeAttributes: [],
  }));
  const [adminToken, setAdminToken] = useState("");
  const [appResponse, setAppResponse] = useState("");
  const [deviceKey, setDeviceKey] = useState("");
  const [key, setKey] = useState<
    TailscaleProvisionedKey | TailscaleKeyHandoff | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [result, setResult] = useState("");
  const [ready, setReady] = useState(false);
  return {
    saved,
    setSaved,
    draft,
    setDraft,
    adminToken,
    setAdminToken,
    appResponse,
    setAppResponse,
    deviceKey,
    setDeviceKey,
    key,
    setKey,
    busy,
    setBusy,
    failure,
    setFailure,
    result,
    setResult,
    ready,
    setReady,
  };
}
export function useTailscaleState(connectionId: string | undefined) {
  const fields = useTailscaleFields();
  const {
    setKey,
    setAdminToken,
    setAppResponse,
    setDeviceKey,
    setBusy,
    setSaved,
    setDraft,
    setReady,
    setFailure,
    setResult,
    key,
  } = fields;
  const turn = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const clear = useCallback(() => {
    turn.current++;
    abort.current?.abort();
    abort.current = null;
    setKey(null);
    setAdminToken("");
    setAppResponse("");
    setDeviceKey("");
    setBusy(false);
    setResult("");
  }, [setKey, setAdminToken, setAppResponse, setDeviceKey, setBusy, setResult]);
  useTailscaleCredentialLifetime(fields.saved, clear);
  useEffect(() => {
    let mounted = true;
    const release = deps.onLock(clear);
    void deps
      .hydrateTailscaleApps()
      .then(() => {
        if (!mounted) return;
        const loaded = deps.readTailscaleApp(connectionId);
        setSaved(loaded);
        if (loaded)
          setDraft({
            apiBase: loaded.apiBase,
            tailnet: loaded.tailnet,
            name: loaded.name,
            allowedNodeAttributes: loaded.allowedNodeAttributes ?? [],
          });
        setReady(true);
      })
      .catch(() => {
        if (mounted) setFailure("Could not load the Tailscale configuration.");
      });
    return () => {
      mounted = false;
      turn.current++;
      abort.current?.abort();
      release();
    };
  }, [connectionId, clear, setDraft, setFailure, setReady, setSaved]);
  useEffect(() => {
    if (!key?.expiresAt) return;
    const timer = setTimeout(
      () => setKey(null),
      Math.max(0, key.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [key, setKey]);
  return { ...fields, turn, abort, clear };
}
export type TailscaleState = ReturnType<typeof useTailscaleState>;
