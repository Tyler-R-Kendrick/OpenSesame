import { Suspense, lazy } from "react";

export type FormatHintProps = {
  /** The item type whose field is being edited, when there is one. */
  typeId?: string;
  value: string;
};

const FormatHintMatch = lazy(() =>
  import("./FormatHintMatch.js").then((module) => ({
    default: module.FormatHintMatch,
  })),
);

/** Load format algorithms only for a nonempty value in the item editor. */
export function FormatHint(props: FormatHintProps) {
  if (props.value.trim() === "") return null;
  return (
    <Suspense fallback={null}>
      <FormatHintMatch {...props} />
    </Suspense>
  );
}
