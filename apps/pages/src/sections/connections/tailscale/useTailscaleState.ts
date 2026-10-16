import type { TailscaleKeyHandoff } from "@opensesame/app-core/lib/tailscale/artifacts.js";
import {
  type TailscaleAppConfiguration,
  type TailscaleProvisionedKey,
  tailscaleAppName,
} from "@opensesame/app-core/lib/tailscale/oauth-app.js";
import type { SavedTailscaleApp } from "@opensesame/app-core/lib/tailscale/store.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVault } from "../../../lib/vault/hooks.js";
import { tailscaleAppDependencies as deps } from "./tailscale-dependencies.js";
import { hydrateTailscaleDeviceRows } from "./tailscale-hydration.js";
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
  const latest = useRef({ connectionId, saved: fields.saved });
  latest.current = { connectionId, saved: fields.saved };
  const { tomb } = useVault();
  useEffect(() => {
    let mounted = true;
    setReady(false);
    const release = deps.onLock(clear);
    void hydrateTailscaleDeviceRows(tomb)
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
      // The saved app surfacing as a connection mid-action is not a
      // configuration change: do not abort the action that created it.
      if (latest.current.saved?.connectionId !== latest.current.connectionId) {
        turn.current++;
        abort.current?.abort();
      }
      release();
    };
  }, [connectionId, tomb, clear, setDraft, setFailure, setReady, setSaved]);
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
