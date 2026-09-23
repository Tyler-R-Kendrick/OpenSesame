import type { ShellWrapperContribution } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import type { ReactNode } from "react";

/**
 * The shell body inside every wrapper an approved capability contributed,
 * lowest `order` outermost and ties broken by id, so the tree is the same
 * whichever sequence the modules activated in. A build that approved none
 * renders `children` and nothing else — there is no wrapper component in
 * the core tree to be empty.
 */
export function Wrapped({
  wrappers,
  children,
}: {
  wrappers: readonly ShellWrapperContribution[];
  children: ReactNode;
}) {
  return [...wrappers]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .reduceRight(
      (inner, entry) => <entry.Wrapper key={entry.id}>{inner}</entry.Wrapper>,
      children,
    );
}
