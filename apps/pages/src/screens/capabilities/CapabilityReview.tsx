/**
 * Before / after — what Apply would change, from the store's review.
 *
 * The review is the consent object: capabilities enabled and disabled, the
 * modules, egress and permissions the after-plan gains, any worker change
 * or reload, every conflict with the alternative the plan could run instead,
 * and the consent delta the receipt will bind. Apply is the one `.go`;
 * Cancel discards the draft with no side effect at all (CONSENT-02). Escape
 * is Cancel.
 */

import type {
  CapabilityCatalog,
  CapabilityId,
  CompositionChangeReview,
  PlanConflict,
} from "@opensesame/capability-composition";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { IconCheck, IconX } from "../../components/Icons.js";

function Row({
  name,
  ids,
  titleOf,
}: { name: string; ids: readonly string[]; titleOf: (id: string) => string }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{ids.length > 0 ? ids.map(titleOf).join(", ") : "—"}</dd>
    </>
  );
}

function ConflictRow({
  conflict,
  alternatives,
  titleOf,
  onReplace,
}: {
  conflict: PlanConflict;
  alternatives: readonly CapabilityId[];
  titleOf: (id: CapabilityId) => string;
  onReplace: (from: CapabilityId, to: CapabilityId) => void;
}) {
  return (
    <li className="caprev__conflict">
      <p>
        <strong>{titleOf(conflict.capability)}</strong>
        {` — ${conflict.message}`}
      </p>
      {alternatives.length > 0 ? (
        <div
          className="capcard__alts"
          aria-label={`Instead of ${titleOf(conflict.capability)}`}
        >
          {alternatives.map((id) => (
            <button
              key={id}
              type="button"
              className="preset__opt"
              onClick={() => onReplace(conflict.capability, id)}
            >
              <span className="preset__name">{titleOf(id)}</span>
              <span className="preset__kind">instead</span>
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

const identity = (id: string) => id;

function egressLine(review: CompositionChangeReview): string {
  if (review.addedEgress.length === 0) return "—";
  return review.addedEgress
    .map(
      (entry) =>
        `${entry.class} → ${entry.purpose}${entry.automatic ? " (on its own)" : ""}`,
    )
    .join("; ");
}

function workerLine(review: CompositionChangeReview): string {
  const transition = review.workerTransition;
  if (!transition) return "unchanged";
  return `${transition.from ?? "core"} → ${transition.to ?? "core"}`;
}

/** Before / after as one list of claims, each read from the review alone. */
function ReviewDelta({
  review,
  titleOf,
}: {
  review: CompositionChangeReview;
  titleOf: (id: string) => string;
}) {
  return (
    <dl className="caprev__delta">
      <Row name="enable" ids={review.enabled} titleOf={titleOf} />
      <Row name="disable" ids={review.disabled} titleOf={titleOf} />
      <Row name="new modules" ids={review.addedModules} titleOf={identity} />
      <dt>new egress</dt>
      <dd>{egressLine(review)}</dd>
      <Row
        name="new permissions"
        ids={review.addedPermissions}
        titleOf={identity}
      />
      <dt>worker</dt>
      <dd>{workerLine(review)}</dd>
      <Row
        name="reload after enabling"
        ids={review.requiresDocumentReload}
        titleOf={titleOf}
      />
      <Row
        name="restart to unload"
        ids={review.restartRequiredFor}
        titleOf={identity}
      />
      <Row
        name="new roots to accept"
        ids={review.consent.addedRoots}
        titleOf={titleOf}
      />
      <Row
        name="new dependencies"
        ids={review.consent.addedDependencies}
        titleOf={titleOf}
      />
      <Row
        name="removed roots"
        ids={review.consent.removedRoots}
        titleOf={titleOf}
      />
      <Row
        name="required, not accepted"
        ids={review.consent.requiredNotAccepted}
        titleOf={titleOf}
      />
    </dl>
  );
}

function ReviewFoot({
  busy,
  blocked,
  onApply,
  onCancel,
}: {
  busy: boolean;
  blocked: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const verb = busy ? "Applying…" : "Apply configuration";
  return (
    <div className="caprev__foot">
      <button
        type="button"
        className="icon-btn"
        aria-label="Cancel"
        title="Cancel"
        disabled={busy}
        onClick={onCancel}
      >
        <IconX size={18} />
      </button>
      <div className="go-row">
        <button
          type="button"
          className="go"
          aria-label={verb}
          title={verb}
          aria-busy={busy}
          disabled={busy || blocked}
          data-testid="capability-apply"
          onClick={onApply}
        >
          <IconCheck size={18} />
        </button>
        <span className="go-verb" aria-hidden="true">
          {verb}
        </span>
      </div>
    </div>
  );
}

export function CapabilityReview({
  review,
  catalog,
  alternativesFor,
  busy,
  onApply,
  onCancel,
  onReplace,
}: {
  review: CompositionChangeReview;
  catalog: CapabilityCatalog;
  alternativesFor: (root: CapabilityId) => readonly CapabilityId[];
  busy: boolean;
  onApply: () => void;
  onCancel: () => void;
  onReplace: (from: CapabilityId, to: CapabilityId) => void;
}) {
  const frame = useRef<HTMLElement>(null);
  const titleOf = (id: string) =>
    catalog.capabilities.find((entry) => entry.id === id)?.title ?? id;
  // The review takes the keyboard when it opens so Escape and Tab start
  // inside it; the caller lands focus back on the first road when it closes.
  useEffect(() => {
    frame.current?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onCancel();
  };
  const blocked =
    review.conflicts.length > 0 ||
    review.consent.requiredNotAccepted.length > 0;
  return (
    <section
      ref={frame}
      className="caprev"
      tabIndex={-1}
      aria-label="Review changes"
      data-testid="capability-review"
      onKeyDown={onKeyDown}
    >
      <ReviewDelta review={review} titleOf={titleOf} />
      {review.conflicts.length > 0 ? (
        <ul className="reqs__list" aria-label="Conflicts">
          {review.conflicts.map((conflict) => (
            <ConflictRow
              key={`${conflict.capability}:${conflict.subject}`}
              conflict={conflict}
              alternatives={alternativesFor(conflict.capability)}
              titleOf={titleOf}
              onReplace={onReplace}
            />
          ))}
        </ul>
      ) : null}
      <ReviewFoot
        busy={busy}
        blocked={blocked}
        onApply={onApply}
        onCancel={onCancel}
      />
    </section>
  );
}
