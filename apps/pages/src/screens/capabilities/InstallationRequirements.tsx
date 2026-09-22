/**
 * A managed instance's required roots, awaiting an explicit yes (MODEL-10).
 *
 * Shown wherever `plan.consent.requiredNotAccepted` is non-empty — the front
 * door, the unlock form, the join road of setup. It lists each required
 * capability from its descriptor, and offers exactly two answers: accept
 * (the `.go`) or decline. Declining leaves the person on the local path with
 * nothing enabled and nothing deleted; it writes nothing. The prohibition
 * itself is never something this panel can change.
 */

import type {
  CapabilityCatalog,
  CapabilityId,
} from "@opensesame/capability-composition";
import { IconCheck, IconSettings, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

export function InstallationRequirements({
  required,
  catalog,
  instanceId,
  onAccept,
  onDecline,
  onReview,
}: {
  required: readonly CapabilityId[];
  catalog: CapabilityCatalog;
  instanceId: string;
  onAccept: () => void;
  onDecline: () => void;
  /** The entry action into setup's capabilities tab, where the cards are. */
  onReview?: () => void;
}) {
  if (required.length === 0) return null;
  const verb = "Accept required capabilities";
  return (
    <section
      className="reqs"
      aria-label={`Required by ${instanceId}`}
      data-testid="installation-requirements"
    >
      <p className="capset__title">{`${instanceId} requires`}</p>
      <ul className="reqs__list">
        {required.map((id) => {
          const descriptor = catalog.capabilities.find(
            (entry) => entry.id === id,
          );
          return (
            <li key={id} className="reqs__item">
              <StatusMark tone="warn" label="acceptance required" />
              <span>
                {descriptor?.title ?? id}
                <small>{descriptor?.summary ?? id}</small>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="reqs__foot">
        <span className="capcard__side">
          <button
            type="button"
            className="icon-btn"
            aria-label="Decline required capabilities"
            title="Decline required capabilities"
            onClick={onDecline}
          >
            <IconX size={18} />
          </button>
          {onReview ? (
            <button
              type="button"
              className="icon-btn"
              aria-label="Review capabilities"
              title="Review capabilities"
              onClick={onReview}
            >
              <IconSettings size={18} />
            </button>
          ) : null}
        </span>
        <div className="go-row">
          <button
            type="button"
            className="go"
            aria-label={verb}
            title={verb}
            onClick={onAccept}
          >
            <IconCheck size={18} />
          </button>
          <span className="go-verb" aria-hidden="true">
            {verb}
          </span>
        </div>
      </div>
    </section>
  );
}
