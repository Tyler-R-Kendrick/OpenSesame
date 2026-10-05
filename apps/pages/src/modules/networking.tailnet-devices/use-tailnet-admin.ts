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
  /**
   * Why the auth keys or the activity could not be read, in words; empty when
   * they were. A daemon whose OAuth client has `devices:core` alone still
   * lists its devices.
   */
  keysError: string;
  auditError: string;
  /** When it was read, for "last seen" and expiry. */
  at: number;
}>;

/** A destructive key one press arms and a second fires. */
export type Armed = Readonly<{ action: string; id: string }>;

/** Words for a refusal; anything that is not one is the daemon not answering. */
const UNREACHABLE = new TailnetAdminError("unreachable");

/** Words for a refusal; anything that is not one is the daemon not answering. */
function wordsOf(caught: Error): string {
  return tailnetErrorText(
    caught instanceof TailnetAdminError ? caught : UNREACHABLE,
  );
}

/** The status and the devices, or nothing; the keys and activity on their own. */
async function readAll(admin: TailnetAdmin): Promise<Loaded> {
  const optional = Promise.allSettled([admin.listKeys(), admin.audit()]);
  const [status, devices] = await Promise.all([
    admin.status(),
    admin.listDevices(),
  ]);
  const [keys, audit] = await optional;
  return {
    status,
    devices,
    keys: keys.status === "fulfilled" ? keys.value : [],
    keysError: keys.status === "rejected" ? wordsOf(keys.reason) : "",
    audit: audit.status === "fulfilled" ? audit.value : [],
    auditError: audit.status === "rejected" ? wordsOf(audit.reason) : "",
    at: Date.now(),
  };
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
      // Part of a change may have landed before the refusal: read again so
      // no row shows a state the daemon no longer reports.
      await load();
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
