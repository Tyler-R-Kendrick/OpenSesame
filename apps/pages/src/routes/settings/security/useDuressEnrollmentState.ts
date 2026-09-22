import type { PolicyDocument } from "@opensesame/contracts";
import { useEffect, useId, useMemo, useState } from "react";
import {
  type ArmingChecklist,
  type CodeSlotStatus,
  type PresetId,
  type RecipientPlan,
  SETTINGS_FIXTURE_CATALOG,
  buildPresetPolicy,
  emptyArmingChecklist,
  resolveMotionPreference,
} from "../../../lib/duress/settings/index.js";
import type { EnrollmentState } from "../../../lib/duress/trigger/enrollment.js";
import type { DuressEnrollmentPanelProps } from "./DuressEnrollmentPanel.js";

type EnrollmentScope = Readonly<{
  ownerPrincipalRef: string;
  organizationRef: string | null;
  vaultRef: string;
  deviceBindingRef: string;
  compartmentRefs: readonly string[];
}>;

const DEFAULT_SCOPE = {
  ownerPrincipalRef: "owner-1",
  organizationRef: null,
  vaultRef: "vault-1",
  deviceBindingRef: "device-1",
  compartmentRefs: ["comp-normal", "comp-restricted", "comp-decoy"],
} satisfies EnrollmentScope;

export function useDuressEnrollmentState(props: DuressEnrollmentPanelProps) {
  const catalog = props.catalog ?? SETTINGS_FIXTURE_CATALOG;
  const scope = props.scope ?? DEFAULT_SCOPE;
  const titleId = useId();
  const [mode, setMode] = useState<"preset" | "advanced">("preset");
  const [presetId, setPresetId] = useState<PresetId>("SC-ALERT-ONLY");
  const [advancedJson, setAdvancedJson] = useState("");
  const [checklist, setChecklist] = useState<ArmingChecklist>(
    emptyArmingChecklist({ durableStorage: catalog.durableStorage }),
  );
  const [recipients, setRecipients] = useState<RecipientPlan[]>([]);
  const [slot, setSlot] = useState<CodeSlotStatus | null>(null);
  const [codeDraft, setCodeDraft] = useState("");
  const [prevCodeDraft, setPrevCodeDraft] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [importRaw, setImportRaw] = useState("");
  const [rehearsalNote, setRehearsalNote] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [enrollmentState, setEnrollmentState] =
    useState<EnrollmentState | null>(null);
  const [motion, setMotion] = useState<"full" | "reduced">("full");

  useEffect(() => {
    if (globalThis.window === undefined || !globalThis.window.matchMedia)
      return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setMotion(resolveMotionPreference(mq));
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  const document = useMemo((): PolicyDocument | null => {
    if (mode === "preset") {
      return buildPresetPolicy(presetId, {
        ...scope,
        compartmentRefs: [...scope.compartmentRefs],
      });
    }
    if (!advancedJson.trim()) return null;
    try {
      // SAFETY: advanced JSON is owner-supplied policy preview input only.
      return JSON.parse(advancedJson) as PolicyDocument;
    } catch {
      return null;
    }
  }, [mode, presetId, scope, advancedJson]);

  return {
    props,
    catalog,
    scope,
    titleId,
    mode,
    setMode,
    presetId,
    setPresetId,
    advancedJson,
    setAdvancedJson,
    checklist,
    setChecklist,
    recipients,
    setRecipients,
    slot,
    setSlot,
    codeDraft,
    setCodeDraft,
    prevCodeDraft,
    setPrevCodeDraft,
    codeError,
    setCodeError,
    importRaw,
    setImportRaw,
    rehearsalNote,
    setRehearsalNote,
    armed,
    setArmed,
    enrollmentState,
    setEnrollmentState,
    motion,
    document,
  };
}
