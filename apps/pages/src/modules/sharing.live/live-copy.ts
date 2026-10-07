import {
  assertNotDecoySession,
  currentRealmGeneration,
} from "@opensesame/app-core/lib/decoy-session.js";
import {
  type LiveCopySource,
  pinLiveGuestCopy,
} from "@opensesame/app-core/lib/live/guest-copy.js";
import type { LiveGuest } from "@opensesame/app-core/lib/live/guest.js";
import type { Catalog } from "@opensesame/app-core/lib/live/messages.js";
import { onLiveSessionChange } from "@opensesame/app-core/lib/live/session.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useCallback, useEffect, useMemo } from "react";
import {
  type ClipboardCopy,
  acceptClipboardCopy,
  beginClipboardCopy,
  clearClipboardCopy,
} from "../../lib/vault/clipboard-ownership.js";
import type { CopyResult } from "../../lib/vault/hooks.js";

type LiveCopyLifetime = {
  check: (() => void) | null;
  active: boolean;
  generation: number;
  owned: ClipboardCopy | null;
};

/** The render that exposed this code/value pins its own live guest authority. */
function useLiveClipboard(guest: LiveGuest, source: LiveCopySource) {
  const lifetime = useMemo<LiveCopyLifetime>(() => {
    let check: (() => void) | null = null;
    try {
      check = pinLiveGuestCopy(guest, source);
    } catch {
      // A retired session can coexist briefly with the previous rendered row.
    }
    return { check, active: true, generation: 0, owned: null };
  }, [guest, source]);
  const check = lifetime.check;
  const pin = useCallback(() => {
    const generation = lifetime.generation;
    const realm = currentRealmGeneration();
    return () => {
      assertNotDecoySession(realm);
      if (!lifetime.active || lifetime.generation !== generation || !check)
        throw new Error("The original live copy control retired.");
      check();
    };
  }, [check, lifetime]);
  useEffect(() => {
    lifetime.active = true;
    const clear = () => {
      const copy = lifetime.owned;
      lifetime.owned = null;
      if (copy && navigator.clipboard)
        void clearClipboardCopy(copy, navigator.clipboard);
    };
    const verify = () => {
      try {
        if (!check) throw new Error("No current live copy authority.");
        check();
      } catch {
        clear();
      }
    };
    const stop = guest.subscribe(verify);
    const unwatch = onLiveSessionChange(verify);
    const unlockWatch = vaultStore.onLock(clear);
    return () => {
      lifetime.active = false;
      lifetime.generation += 1;
      stop();
      unwatch();
      unlockWatch();
      clear();
    };
  }, [guest, check, lifetime]);
  const copy = useCallback(
    async (value: string): Promise<CopyResult> => {
      const ensure = pin();
      try {
        if (!navigator.clipboard?.writeText) return "unavailable";
        ensure();
        if (source.kind === "request" && value !== source.code)
          return "unavailable";
      } catch {
        return "unavailable";
      }
      const next = beginClipboardCopy(value);
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        return "unavailable";
      }
      try {
        ensure();
        if (!acceptClipboardCopy(next))
          throw new Error("A newer copy completed.");
      } catch {
        await clearClipboardCopy(next, navigator.clipboard);
        return "unavailable";
      }
      lifetime.owned = next;
      return "copied";
    },
    [pin, source, lifetime],
  );
  return { pin, copy };
}

export function useLiveRequestClipboard(guest: LiveGuest, code: string) {
  const source = useMemo<LiveCopySource>(
    () => ({ kind: "request", code }),
    [code],
  );
  return useLiveClipboard(guest, source);
}

export function useLiveCatalogClipboard(guest: LiveGuest, catalog: Catalog) {
  const source = useMemo<LiveCopySource>(
    () => ({ kind: "catalog", catalog }),
    [catalog],
  );
  return useLiveClipboard(guest, source);
}
