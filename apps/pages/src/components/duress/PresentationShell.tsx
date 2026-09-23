import type { ScopedView } from "@opensesame/app-core/lib/duress/compartment/scope.js";
import { createElement } from "react";

/**
 * Presentation shell for restricted/decoy/locked sessions.
 * Shows only cryptographically admitted content — no sensitive incident labels.
 */
export function PresentationShell(props: {
  view: ScopedView;
  onSearch: (q: string) => void;
}) {
  if (props.view.locked) {
    return createElement(
      "section",
      { "aria-label": "Vault", className: "duress-presentation locked" },
      createElement("p", { role: "status" }, "Vault locked"),
    );
  }

  return createElement(
    "section",
    {
      "aria-label": "Vault",
      className: `duress-presentation ${props.view.presentation}`,
    },
    createElement("input", {
      type: "search",
      "aria-label": "Search items",
      onChange: (e: { currentTarget: { value: string } }) =>
        props.onSearch(e.currentTarget.value),
    }),
    createElement(
      "p",
      { "aria-live": "polite" },
      `${props.view.counts.total} items`,
    ),
    createElement(
      "ul",
      null,
      props.view.items.map((item) =>
        createElement("li", { key: item.id }, item.title),
      ),
    ),
  );
}
