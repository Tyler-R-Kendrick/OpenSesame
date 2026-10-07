import { isKnownGuidePredicate, readGuidePredicate } from "./state.js";
import { resolveGuideTargetElement } from "./targets.js";

/** A phone's session controls become pointable after the person opens Sections. */
export function sessionGuide(lines: readonly string[]): string {
  if (
    !isKnownGuidePredicate("shell.narrow") ||
    !readGuidePredicate("shell.narrow")
  )
    return lines.join("\n");

  const firstFocus = lines.findIndex((line) => line.startsWith("focus "));
  const target = ["shell.account", "prompt.tomb"].find((id) =>
    lines[firstFocus]?.startsWith(`focus "${id}"`),
  );
  if (target && resolveGuideTargetElement(target)) return lines.join("\n");
  return [
    ...lines.slice(0, firstFocus),
    'focus "nav.menu" "Open Sections to reach the account and vault controls." side=bottom',
    'wait target "nav.menu" event=activate timeout=30000',
    ...lines.slice(firstFocus),
  ].join("\n");
}
