/**
 * What the tailnet device panels draw from the paired daemon, and the one
 * way they change it: `run` an operation, then read everything again, so a
 * row never shows a state the daemon did not report.
 */

import type { TailnetAdmin } from "@opensesame/app-core/lib/tailnet-admin/client.js";
import {
  TailnetAdminError,
  tailnetErrorText,
} from "@opensesame/app-core/lib/tailnet-admin/errors.js";
import type {
  TailnetAuditEntry,
  TailnetDevice,
  TailnetKey,
  TailnetStatus,
} from "@opensesame/app-core/lib/tailnet-admin/wire.js";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type FocusTarget, useFocusAfter } from "../../lib/use-focus-after.js";

/** How often the list is read again while the page is visible. */
export const REFRESH_MS = 60_000;

export type Loaded = Readonly<{
  status: TailnetStatus;
  devices: readonly TailnetDevice[];
  keys: readonly TailnetKey[];
  audit: readonly TailnetAuditEntry[];
  /** When it was read, for "last seen" and expiry. */
  at: number;
}>;

/** A destructive key one press arms and a second fires. */
export type Armed = Readonly<{ action: string; id: string }>;

/** Words for a refusal; anything that is not one is the daemon not answering. */
const UNREACHABLE = new TailnetAdminError("unreachable");

async function readAll(admin: TailnetAdmin): Promise<Loaded> {
  const [status, devices, keys, audit] = await Promise.all([
    admin.status(),
    admin.listDevices(),
    admin.listKeys(),
    admin.audit(),
  ]);
  return { status, devices, keys, audit, at: Date.now() };
}

/** Read again every `REFRESH_MS` while the page is visible; stop on unmount. */
function useRefresh(
  load: () => Promise<void>,
  generation: { current: number },
) {
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => {
      clearInterval(timer);
      generation.current += 1;
    };
  }, [load, generation]);
}

export function useTailnetAdmin(admin: TailnetAdmin) {
  // Re-render when the pairing moves; the target itself is read fresh.
  useSyncExternalStore(admin.subscribe, () => admin.target()?.revision ?? -1);
  const target = admin.target();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<Armed | null>(null);
  const generation = useRef(0);
  const focusAfter = useFocusAfter(busy);

  const load = useCallback(async () => {
    const current = ++generation.current;
    if (!admin.target()) {
      setLoaded(null);
      return;
    }
    try {
      const read = await readAll(admin);
      if (current !== generation.current) return;
      setLoaded(read);
      // An armed key whose device or auth key went away disarms.
      setArmed((now) =>
        now &&
        [...read.devices, ...read.keys].some((item) => item.id === now.id)
          ? now
          : null,
      );
    } catch (caught) {
      if (current !== generation.current) return;
      setError(
        tailnetErrorText(
          caught instanceof TailnetAdminError ? caught : UNREACHABLE,
        ),
      );
    }
  }, [admin]);

  // Read now, and again whenever a pairing is made, forgotten or swapped for
  // another vault's.
  useEffect(() => {
    void load();
    return admin.subscribe(() => {
      setError("");
      void load();
    });
  }, [admin, load]);

  useRefresh(load, generation);

  /** Run one change; read everything again; land focus where asked. */
  async function run<T>(
    action: () => Promise<T>,
    focus?: FocusTarget,
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await action();
      setArmed(null);
      await load();
      if (focus) focusAfter(focus);
      return true;
    } catch (caught) {
      setError(
        tailnetErrorText(
          caught instanceof TailnetAdminError ? caught : UNREACHABLE,
        ),
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  return {
    admin,
    target,
    loaded,
    error,
    setError,
    busy,
    armed,
    setArmed,
    canManage: target?.role === "manage",
    reload: () => {
      setError("");
      void load();
    },
    run,
  };
}

export type TailnetModel = ReturnType<typeof useTailnetAdmin>;
