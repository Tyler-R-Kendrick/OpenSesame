// Which experience packages a verify:experience run has to walk.
//
// `EXPERIENCE_PACKAGES` is the affected-tests plan's `verify_packages`, comma
// separated: the experience packages a diff reached. Unset or empty means a
// whole-workspace run, which walks every block.

/** @param {string | undefined} value the `EXPERIENCE_PACKAGES` variable */
export function experiencePackages(value) {
  const named = (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return (name) => named.length === 0 || named.includes(name);
}
