import {
  type PresentationClass,
  type VaultItemView,
  projectCounts,
  projectVisibleItems,
} from "@opensesame/app-core/lib/duress/compartment/project.js";
import type { ScopedView } from "@opensesame/app-core/lib/duress/compartment/scope.js";
import { createElement } from "react";

/** Restricted / decoy vault list — prefer ScopedView from openPresentation. */
export function CompartmentProjectionView(
  props:
    | {
        view: ScopedView;
        search?: string;
      }
    | {
        items: readonly VaultItemView[];
        admittedCompartmentRefs: readonly string[];
        presentation: PresentationClass;
        search?: string;
      },
) {
  if ("view" in props) {
    const view = props.view;
    if (view.locked || view.presentation === "locked") {
      return createElement(
        "div",
        { "aria-label": "Vault unavailable", className: "duress-locked" },
        createElement("p", { role: "status" }, "Unavailable."),
      );
    }
    const query = props.search?.toLowerCase();
    const items = query
      ? view.items.filter((i) => i.title.toLowerCase().includes(query))
      : view.items;
    return createElement(
      "div",
      {
        "aria-label": "Vault items",
        className: `duress-projection duress-projection--${view.presentation}`,
        "data-total": String(items.length),
      },
      createElement(
        "p",
        { className: "duress-counts" },
        `${items.length} items`,
      ),
      createElement(
        "ul",
        null,
        items.map((item) => createElement("li", { key: item.id }, item.title)),
      ),
    );
  }

  const visible = projectVisibleItems(
    props.items,
    props.admittedCompartmentRefs,
    props.presentation,
    { search: props.search },
  );
  const counts = projectCounts(
    props.items,
    props.admittedCompartmentRefs,
    props.presentation,
  );

  if (props.presentation === "locked") {
    return createElement(
      "div",
      { "aria-label": "Vault unavailable", className: "duress-locked" },
      createElement("p", null, "Unavailable."),
    );
  }

  return createElement(
    "div",
    {
      "aria-label": "Vault items",
      className: `duress-projection duress-projection--${props.presentation}`,
      "data-total": String(counts.total),
    },
    createElement("p", { className: "duress-counts" }, `${counts.total} items`),
    createElement(
      "ul",
      null,
      visible.map((item) => createElement("li", { key: item.id }, item.title)),
    ),
  );
}
