import type { SuggestOption } from "@opensesame/app-core/lib/vault/path-suggest.js";
import type { KeyboardEvent } from "react";

/** What the keys of a segment read and move; supplied by `usePathSegment`. */
export type SegmentKeyContext = {
  open: boolean;
  /** The list is drawn: open, and there is something in it. */
  expanded: boolean;
  options: readonly SuggestOption[];
  /** The highlighted row's index, already held inside the list. */
  at: number;
  /** The row at `at`, if the list has one. */
  pick: SuggestOption | undefined;
  /** What is typed since entering the field; `null` while it shows the choice. */
  query: string | null;
  /** The chosen value as it reads in the row. */
  text: string;
  show: () => void;
  close: () => void;
  highlight: (index: number) => void;
  take: (option: SuggestOption, byTab?: boolean) => void;
};

/** Down and Up open the list, then move the highlight and stop at its ends. */
function arrow(event: KeyboardEvent<HTMLInputElement>, ctx: SegmentKeyContext) {
  event.preventDefault();
  if (!ctx.open) return ctx.show();
  const by = event.key === "ArrowDown" ? 1 : -1;
  const last = Math.max(ctx.options.length - 1, 0);
  ctx.highlight(Math.min(Math.max(ctx.at + by, 0), last));
}

type KeyHandler = (
  event: KeyboardEvent<HTMLInputElement>,
  ctx: SegmentKeyContext,
) => void;

function enter(event: KeyboardEvent<HTMLInputElement>, ctx: SegmentKeyContext) {
  event.preventDefault();
  if (ctx.expanded && ctx.pick) ctx.take(ctx.pick);
  else ctx.show();
}

function dismiss(
  event: KeyboardEvent<HTMLInputElement>,
  ctx: SegmentKeyContext,
) {
  if (!ctx.open) return;
  event.preventDefault();
  event.stopPropagation();
  ctx.close();
}

function tab(_event: KeyboardEvent<HTMLInputElement>, ctx: SegmentKeyContext) {
  const completes = ctx.query !== null && ctx.expanded;
  if (completes && ctx.pick && ctx.pick.label !== ctx.text)
    ctx.take(ctx.pick, true);
}

const KEYS = new Map<string, KeyHandler>([
  ["ArrowDown", arrow],
  ["ArrowUp", arrow],
  ["Enter", enter],
  ["Escape", dismiss],
  ["Tab", tab],
]);

/**
 * The keys of an editable combobox over a closed list. Enter chooses here and
 * never submits the form from this field; Escape closes an open list before
 * anything else sees it; Tab on the way out takes the highlighted match for
 * something typed, so a half-typed folder completes instead of reverting.
 */
export function handleSegmentKey(
  event: KeyboardEvent<HTMLInputElement>,
  ctx: SegmentKeyContext,
) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  KEYS.get(event.key)?.(event, ctx);
}
