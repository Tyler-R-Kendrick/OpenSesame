/**
 * When a duress presentation session is active, show PresentationShell / DecoyStatus
 * over the vault listing (COMPARTMENT-UX → STORE).
 */

import {
  type ActivePresentation,
  readActivePresentation,
  subscribeActivePresentation,
} from "@opensesame/app-core/lib/duress/compartment/presentation-runtime.js";
import { projectScopedView } from "@opensesame/app-core/lib/duress/compartment/scope.js";
import { createElement, useEffect, useState } from "react";
import { DecoyStatus } from "./DecoyStatus.js";
import { PresentationShell } from "./PresentationShell.js";

export function DuressPresentationOverlay() {
  const [active, setActive] = useState<ActivePresentation | null>(() =>
    readActivePresentation(),
  );
  const [search, setSearch] = useState("");

  useEffect(
    () =>
      subscribeActivePresentation(() => {
        setActive(readActivePresentation());
      }),
    [],
  );

  if (!active) return null;

  const view =
    search.trim().length > 0
      ? projectScopedView(active.outcome, { search })
      : active.view;

  return createElement(
    "div",
    {
      className: "duress-presentation-overlay",
      role: "region",
      "aria-label": "Presentation",
    },
    createElement(DecoyStatus, { outcome: active.outcome }),
    createElement(PresentationShell, {
      view,
      onSearch: setSearch,
    }),
  );
}
