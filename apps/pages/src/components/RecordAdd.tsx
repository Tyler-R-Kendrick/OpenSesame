import type { GuideTargetId } from "@opensesame/guide-lang";
import { type RefObject, useCallback } from "react";
import { AddSlide } from "../sections/vault/AddSlide.js";
import { type AddEntry, useAddEntry } from "../sections/vault/add-menu.js";
import { useAddSlide } from "../sections/vault/add-slide.js";
import { useOptionalGuideTarget } from "../tutorial/registry/react.jsx";
import { IconPlus } from "./Icons.js";
import { openContextMenu } from "./context-menu/menu-model.js";
import type { useRecordWorkspace } from "./record-workspace-state.js";

function controls(list: RefObject<HTMLDivElement | null>) {
  return [
    ...(list.current?.querySelectorAll<HTMLElement>(
      ".record-workspace__commands button, .record-workspace__commands a, .record-workspace__commands input[type=file]",
    ) ?? []),
  ];
}

function SlideEntry({
  list,
  label,
  slide,
}: {
  list: RefObject<HTMLDivElement | null>;
  label: string;
  slide: "up" | "down";
}) {
  const run = useCallback(
    () =>
      controls(list)
        .find((control) => control.getAttribute("aria-label") === label)
        ?.click(),
    [list, label],
  );
  useAddEntry({
    id: `record-${slide}`,
    label,
    slide,
    order: slide === "up" ? 1 : 2,
    run,
  });
  return null;
}

/** The vault's tap-to-add and hold-to-import/export, using this section's commands. */
export function RecordAdd({
  model,
  guide,
}: { model: ReturnType<typeof useRecordWorkspace>; guide?: GuideTargetId }) {
  const {
    list,
    createControl,
    createLabel,
    createDisabled,
    importLabel,
    exportLabel,
  } = model;
  const choose = useCallback((entry: AddEntry) => entry.run(), []);
  const slide = useAddSlide(choose);
  // The proxy is pointable; activation is reported once by the original
  // command it clicks, which retains its normal guide binding.
  const guideRef = useOptionalGuideTarget<HTMLButtonElement>(guide, {
    activation: "manual",
  });
  return (
    <>
      {importLabel ? (
        <SlideEntry list={list} label={importLabel} slide="up" />
      ) : null}
      {exportLabel ? (
        <SlideEntry list={list} label={exportLabel} slide="down" />
      ) : null}
      <button
        ref={guideRef}
        type="button"
        className="record-workspace__add"
        aria-label={createLabel ?? "New record"}
        title={createLabel ?? "New record"}
        disabled={createDisabled}
        {...slide.bind}
        onContextMenu={(event) => {
          event.preventDefault();
          if (slide.holding()) return;
          const entries = controls(list)
            .filter(
              (control) =>
                !/^(New|Add|Register|Create|Grant)\b/.test(
                  control.getAttribute("aria-label") ?? "",
                ),
            )
            .map((control, index) => ({
              id: `record-command-${index}`,
              label: control.getAttribute("aria-label") ?? "Command",
              disabled: control.matches(":disabled"),
              run: () => control.click(),
            }));
          openContextMenu(event, event.currentTarget, "Add actions", [entries]);
        }}
        onClick={(event) => {
          slide.bind.onClick(event);
          if (!event.defaultPrevented) createControl.current?.click();
        }}
      >
        <IconPlus size={24} />
      </button>
      {slide.state ? <AddSlide slide={slide.state} /> : null}
    </>
  );
}
