import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { WordmarkHandle } from "../../components/Wordmark.js";
import { unlockCeremonyStore } from "../../lib/unlock-ceremony-store.js";

type VaultStatus = ReturnType<typeof vaultStore.getSnapshot>["status"];

/** Pane/card/notes refs and ceremony token for CipherDial + VaultDoors. */
export function useUnlockLockV5(status: VaultStatus) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const notesRef = useRef<HTMLElement | null>(null);
  const wordmarkRef = useRef<WordmarkHandle | null>(null);
  const [ceremonyToken, setCeremonyToken] = useState(0);

  const beginCeremonyIfUnlocked = useCallback(
    (before: VaultStatus, blocked: boolean) => {
      const after = vaultStore.getSnapshot().status;
      if (blocked || before === "unlocked" || after !== "unlocked") {
        // The submit armed the hold; no ceremony runs, so let the shell in.
        unlockCeremonyStore.end();
        return;
      }
      setCeremonyToken((n) => n + 1);
    },
    [],
  );

  return {
    stage: {
      paneRef,
      cardRef,
      notesRef,
      wordmarkRef,
      ceremonyToken,
      vaultUnlocked: status === "unlocked",
    },
    beginCeremonyIfUnlocked,
  };
}

/** While the lock-v5 doors open, the card keeps the face it was unlocked from. */
export function useHeldUnlockStatus(status: VaultStatus): VaultStatus {
  const held = useSyncExternalStore(
    unlockCeremonyStore.subscribe,
    unlockCeremonyStore.getSnapshot,
  );
  return held && status === "unlocked" ? "locked" : status;
}
