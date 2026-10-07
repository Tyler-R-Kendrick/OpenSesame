/** These guides are advertised only on an actual owner password/evidence surface. */
export const OWNER_TUTORIALS = Object.freeze([
  "vaults.controlled-canaries",
  "vaults.observation-receiver",
]);

/** An explicit owner-only selection runs there; mixed/all selections keep the ordinary PIN walk. */
export function walkDefaultTutorialCohort(selected) {
  return (
    selected.size === 0 ||
    [...selected].some((id) => !OWNER_TUTORIALS.includes(id))
  );
}
