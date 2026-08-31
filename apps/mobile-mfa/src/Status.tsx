/**
 * The one line a screen says back to the human.
 *
 * Shared so the announcement semantics are decided once. Two things matter and
 * both are easy to lose when every screen rolls its own paragraph: a failure
 * must be `role="alert"` so it interrupts, and every state must carry a mark
 * beside its wording so the panel's colour is never the only thing that says
 * whether the news is good.
 */

export type StatusKind = "ok" | "err";

export interface Notice {
  kind: StatusKind;
  text: string;
}

/**
 * Non-colour signal for each kind.
 *
 * `aria-hidden`, because the sentence beside it already says what happened and
 * a screen reader announcing "exclamation mark" before it is noise.
 */
const MARK = {
  ok: "✓",
  err: "!",
} as const satisfies Record<StatusKind, string>;

export function Status({ notice }: { notice: Notice | null }) {
  if (notice === null) return null;
  return (
    <p
      className={`status status-${notice.kind}`}
      role={notice.kind === "err" ? "alert" : "status"}
      aria-live={notice.kind === "err" ? "assertive" : "polite"}
    >
      <span className="status__mark" aria-hidden="true">
        {MARK[notice.kind]}
      </span>
      <span className="status__text">{notice.text}</span>
    </p>
  );
}
