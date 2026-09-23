import {
  type LimitedCarryPlan,
  buildLimitedCarryPlan,
} from "@opensesame/app-core/lib/duress/compartment/limited-carry.js";
import type { CompartmentItem } from "@opensesame/app-core/lib/duress/compartment/registry.js";
import { createElement, useState } from "react";

function carryPlanArgs(
  sourceItems: readonly CompartmentItem[],
  itemIds: string[],
  carryCompartmentRef: string,
  restoreContextId: string,
  removeFromSource: boolean,
) {
  return {
    sourceItems,
    itemIds,
    carryCompartmentRef,
    restoreContextId,
    removeFromSource,
  };
}

function LimitedCarryItemRow(props: {
  item: CompartmentItem;
  checked: boolean;
  onToggle: (id: string, checked: boolean) => void;
}) {
  return createElement(
    "li",
    { key: props.item.id },
    createElement(
      "label",
      null,
      createElement("input", {
        type: "checkbox",
        checked: props.checked,
        onChange: (e: { currentTarget: { checked: boolean } }) => {
          props.onToggle(props.item.id, e.currentTarget.checked);
        },
      }),
      " ",
      props.item.title,
    ),
  );
}

function LimitedCarryExposurePreview(props: {
  preview: NonNullable<
    ReturnType<typeof buildLimitedCarryPlan>["exposurePreview"]
  >;
}) {
  return createElement(
    "aside",
    { "aria-label": "Exposure preview" },
    createElement(
      "p",
      null,
      `Will carry: ${props.preview.carriedTitles.join(", ")}`,
    ),
    createElement(
      "ul",
      null,
      props.preview.knownCopyLimitations.map((line) =>
        createElement("li", { key: line }, line),
      ),
    ),
  );
}

/**
 * Limited-carry picker: owner selects everyday items with exposure preview.
 */
export function LimitedCarryPicker(props: {
  sourceItems: readonly CompartmentItem[];
  carryCompartmentRef: string;
  restoreContextId: string;
  onConfirm: (plan: LimitedCarryPlan) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [removeFromSource, setRemoveFromSource] = useState(true);

  const planArgs = carryPlanArgs(
    props.sourceItems,
    selected,
    props.carryCompartmentRef,
    props.restoreContextId,
    removeFromSource,
  );
  const preview =
    selected.length > 0
      ? buildLimitedCarryPlan(planArgs).exposurePreview
      : null;

  const toggleItem = (id: string, checked: boolean) => {
    setSelected((prev) =>
      checked ? [...prev, id] : prev.filter((x) => x !== id),
    );
  };

  return createElement(
    "section",
    { "aria-label": "Limited carry", className: "limited-carry-picker" },
    createElement("h2", null, "Limited carry"),
    createElement(
      "p",
      null,
      "Select items to keep under a separate independently keyed compartment. Prior offline copies may remain decryptable.",
    ),
    createElement(
      "ul",
      null,
      props.sourceItems.map((item) =>
        createElement(LimitedCarryItemRow, {
          key: item.id,
          item,
          checked: selected.includes(item.id),
          onToggle: toggleItem,
        }),
      ),
    ),
    createElement(
      "label",
      null,
      createElement("input", {
        type: "checkbox",
        checked: removeFromSource,
        onChange: (e: { currentTarget: { checked: boolean } }) =>
          setRemoveFromSource(e.currentTarget.checked),
      }),
      " Remove selected from source after carry",
    ),
    preview ? createElement(LimitedCarryExposurePreview, { preview }) : null,
    createElement(
      "button",
      {
        type: "button",
        disabled: selected.length === 0,
        onClick: () => props.onConfirm(buildLimitedCarryPlan(planArgs)),
      },
      "Confirm limited carry",
    ),
  );
}
