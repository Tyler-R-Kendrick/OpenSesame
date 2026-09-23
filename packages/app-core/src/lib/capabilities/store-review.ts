/**
 * What a draft would change, stated the way a consent screen has to state it.
 *
 * Lifted out of `store.ts` so the store keeps to its size budget, and pure
 * so it can be read without a store at all: everything it needs is passed in.
 */

import {
  type CapabilityCatalog,
  type CompositionChangeReview,
  type ConsentReceipt,
  type EffectivePlan,
  type InstallationCapabilitySelection,
  buildConsentReceipt,
  reviewCompositionChange,
} from "@opensesame/capability-composition";

export type ResolveWithReceipt = (
  draft: InstallationCapabilitySelection,
  receipt: ConsentReceipt | null,
) => EffectivePlan;

/**
 * Two resolutions of the same draft, deliberately.
 *
 * `owed` resolves under the receipt this installation actually holds: it
 * carries the delta the person is being asked to accept, and the conflicts
 * that block Apply. `after` resolves under the receipt Apply would then
 * write, and only that plan can say which capabilities start, which modules
 * load and what leaves the device — a capability counts as approved once a
 * receipt covers it, so previewing under the old receipt reported an empty
 * `enable` row for every new root and told a person that a change about to
 * start five capabilities changed nothing.
 *
 * The delta and the conflicts stay the strict ones, from `owed`. Nothing
 * here may make Apply look permitted when the receipt in hand does not.
 */
export function reviewDraft(
  draft: InstallationCapabilitySelection,
  {
    current,
    catalog,
    receipt,
    resolveWith,
    now,
  }: {
    current: EffectivePlan;
    catalog: CapabilityCatalog;
    receipt: ConsentReceipt | null;
    resolveWith: ResolveWithReceipt;
    now: () => string;
  },
): CompositionChangeReview {
  const owed = resolveWith(draft, receipt);
  const after = resolveWith(draft, buildConsentReceipt(owed, catalog, now()));
  return {
    ...reviewCompositionChange(current, after, catalog),
    conflicts: owed.conflicts,
    consent: owed.consent,
  };
}
