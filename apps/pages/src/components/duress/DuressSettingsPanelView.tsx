import {
  type ArmingChecklist,
  PRESET_CATALOG,
  type PresetId,
  activationRequiresNewPermissionPrompt,
} from "@opensesame/app-core/lib/duress/settings/index.js";
import type { PresetMeta } from "@opensesame/app-core/lib/duress/settings/preset-catalog.js";
import { isPresetId } from "@opensesame/app-core/lib/duress/settings/presets.js";
import { type Dispatch, type SetStateAction, createElement } from "react";

const ARMING_CHECKLIST_ITEMS = [
  ["ownerConsent", "I am the affected owner and authorize this scope"],
  ["destructiveAck", "I understand destructive and hold effects (if any)"],
  ["rehearsalPassed", "Isolated rehearsal completed without side effects"],
  ["enrolledTriggers", "Triggers enrolled (codes never shown here)"],
  ["exposureReviewed", "I reviewed the compiler exposure summary"],
] as const satisfies ReadonlyArray<readonly [keyof ArmingChecklist, string]>;

export function DuressSettingsPanelView(props: {
  motionClass: string;
  presetId: PresetId;
  setPresetId: (id: PresetId) => void;
  preset: PresetMeta;
  exposureSummary: readonly string[];
  checklist: ArmingChecklist;
  setChecklist: Dispatch<SetStateAction<ArmingChecklist>>;
  ready: boolean;
  onArm: () => void;
}) {
  return createElement(
    "section",
    {
      "aria-label": "Duress protection",
      className: props.motionClass,
      "data-permission-prompt": String(activationRequiresNewPermissionPrompt()),
    },
    createElement("h2", null, "Duress profiles"),
    createElement(
      "p",
      null,
      "Optional protection that changes what this device reveals under coercion. It does not guarantee personal safety, undetectability, or forensic erasure.",
    ),
    createElement("label", { htmlFor: "duress-preset" }, "Preset"),
    createElement(
      "select",
      {
        id: "duress-preset",
        value: props.presetId,
        onChange: (e: { currentTarget: { value: string } }) => {
          const next = e.currentTarget.value;
          if (isPresetId(next)) props.setPresetId(next);
        },
      },
      ...PRESET_CATALOG.map((p) =>
        createElement("option", { key: p.id, value: p.id }, p.title),
      ),
    ),
    createElement("p", null, props.preset.summary),
    createElement(
      "p",
      { className: "duress-honest-limit" },
      props.preset.honestLimit,
    ),
    createElement(
      "ul",
      { "aria-label": "Compiler exposure summary" },
      props.exposureSummary.map((line) =>
        createElement("li", { key: line }, line),
      ),
    ),
    ...ARMING_CHECKLIST_ITEMS.map(([key, label]) =>
      createElement(
        "label",
        { key, className: "duress-check" },
        createElement("input", {
          type: "checkbox",
          checked: props.checklist[key],
          onChange: (e: { currentTarget: { checked: boolean } }) =>
            props.setChecklist((c) => ({
              ...c,
              [key]: e.currentTarget.checked,
            })),
        }),
        " ",
        label,
      ),
    ),
    createElement(
      "button",
      {
        type: "button",
        disabled: !props.ready,
        onClick: props.onArm,
      },
      "Arm after rehearsal",
    ),
  );
}
