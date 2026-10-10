import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useCallback, useRef, useState } from "react";
import type { WordmarkHandle } from "../../components/Wordmark.js";

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
      if (blocked || before === "unlocked" || after !== "unlocked") return;
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
