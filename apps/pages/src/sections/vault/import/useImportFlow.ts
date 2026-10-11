import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import type { SourceId } from "@opensesame/app-core/lib/vault/import/index.js";
import type { MergePlan } from "@opensesame/app-core/lib/vault/import/merge.js";
import {
  type ImportStage,
  type StageOutcome,
  confirmManifestStage,
  confirmStage,
  readStage,
  reparseStage,
  restoreStage,
  restoreWithPasskey,
  unlockStage,
} from "@opensesame/app-core/sections/vault/import/model.js";
import {
  type LandingChoice,
  landingDefaults,
  planImport,
} from "@opensesame/app-core/sections/vault/import/preview.js";
import {
  type ManifestPlan,
  planStoreManifest,
} from "@opensesame/app-core/sections/vault/import/store-manifest.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVault, useVaultStore } from "../../../lib/vault/hooks.js";

const NOTICE = "vault-import";

export type ImportFlow = Readonly<{
  stage: ImportStage;
  error: string | null;
  busy: boolean;
  choice: LandingChoice | null;
  plan: MergePlan | null;
  /** The by-path merge a store path manifest would make. */
  manifestPlan: ManifestPlan | null;
  setChoice: (next: LandingChoice) => void;
  reparse: (source: SourceId) => void;
  unlock: (password: string) => void;
  /** `adoptIdentity`: the person chose to take the backup's device identity. */
  restore: (password: string, adoptIdentity: boolean) => void;
  restorePasskey: (adoptIdentity: boolean) => void;
  confirm: () => void;
}>;

/**
 * The sheet's React binding over the import model: one transition at a
 * time, each outcome landing in one place. A failure is a mark in the sheet
 * and a status notice in the tray — never a box in the page. `onDone` runs
 * once, when a merge or a restore has been written.
 */
export function useImportFlow(file: File, onDone?: () => void): ImportFlow {
  const { items, folders } = useVault();
  const store = useVaultStore();
  const [stage, setStage] = useState<ImportStage>({
    step: "reading",
    fileName: file.name,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<LandingChoice | null>(null);
  const current = useRef(stage);
  current.current = stage;

  const land = (outcome: StageOutcome) => {
    const next = outcome.stage;
    const before = current.current;
    if (
      next.step === "preview" &&
      (before.step !== "preview" || before.result !== next.result)
    ) {
      setChoice(landingDefaults(next.result));
    }
    current.current = next;
    setStage(next);
    setError(outcome.error);
    // Whoever opened the sheet may need to know the items are in the vault.
    if (next.step === "done" && before.step !== "done") onDone?.();
    if (outcome.error !== null) {
      setStatusNotice({
        id: NOTICE,
        tone: "err",
        title: "Import",
        body: outcome.error,
      });
    } else {
      dismissNotice(NOTICE);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new file is the only thing that starts a new read
  useEffect(() => {
    let live = true;
    const reading: ImportStage = { step: "reading", fileName: file.name };
    current.current = reading;
    setStage(reading);
    setError(null);
    void readStage(file).then((outcome) => {
      if (live) land(outcome);
    });
    return () => {
      live = false;
    };
  }, [file]);

  const plan = useMemo(
    () =>
      stage.step === "preview" && choice
        ? planImport(stage.result, items, folders, choice)
        : null,
    [stage, choice, items, folders],
  );
  const manifestPlan = useMemo(
    () =>
      stage.step === "manifest"
        ? planStoreManifest(stage.entries, items, folders)
        : null,
    [stage, items, folders],
  );

  const run = (transition: () => Promise<StageOutcome>) => {
    setBusy(true);
    void transition()
      .then(land)
      .finally(() => setBusy(false));
  };

  return {
    stage,
    error,
    busy,
    choice,
    plan,
    manifestPlan,
    setChoice,
    reparse: (source) => run(() => reparseStage(current.current, source)),
    unlock: (password) => run(() => unlockStage(current.current, password)),
    restore: (password, adoptIdentity) =>
      run(() =>
        restoreStage(current.current, password, store, { adoptIdentity }),
      ),
    restorePasskey: (adoptIdentity) =>
      run(() => restoreWithPasskey(current.current, store, { adoptIdentity })),
    confirm: () => {
      if (plan) run(() => confirmStage(current.current, plan, store));
      if (manifestPlan) {
        run(() => confirmManifestStage(current.current, manifestPlan, store));
      }
    },
  };
}
