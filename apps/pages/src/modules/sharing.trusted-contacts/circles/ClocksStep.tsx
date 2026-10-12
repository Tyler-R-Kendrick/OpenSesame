/**
 * Step four of a new circle: the clocks, and the key that makes the circle.
 * What a recovering circle protects is read from the vault when the key is
 * pressed, not before, and goes straight to the desk.
 */

import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { ClocksFields } from "./ClocksFields.js";
import type { ClocksDraft, Issue, Review } from "./circle-model.js";

export function ClocksStep({
  clocks,
  onClocks,
  recovers,
  issues,
  review,
  busy,
  failure,
  onMake,
}: {
  clocks: ClocksDraft;
  onClocks: (next: ClocksDraft) => void;
  recovers: boolean;
  issues: readonly Issue[];
  review: Review;
  busy: boolean;
  /** The sentence for why the circle was not made, when it was not. */
  failure: string;
  onMake: () => void;
}) {
  const blocked = issues.length > 0 || review.issues.length > 0;
  return (
    <form
      aria-label="Set the clocks"
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked && !busy) onMake();
      }}
    >
      <CeremonyShell
        name="Clocks"
        primary={{
          label: "Make the circle",
          submit: true,
          busy,
          disabled: blocked,
          onClick: () => undefined,
        }}
      >
        <ClocksFields
          clocks={clocks}
          onClocks={onClocks}
          recovers={recovers}
          issues={issues}
          review={review}
        />
        {failure ? <StatusMark tone="err" label={failure} /> : null}
      </CeremonyShell>
    </form>
  );
}
