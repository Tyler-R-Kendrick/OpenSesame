/**
 * `/i/:ref` and `/approve/:ref` as route elements whose screens arrive only
 * when their route opens (ADR 0140 plan step 9): the interaction ceremony,
 * the approval review and the WebAuthn port they run are split out of the
 * ceremonies module, so `/device` and `/claim` never load them.
 */

import { Suspense, lazy } from "react";

const InteractionScreen = lazy(() =>
  import("./InteractionScreen.js").then((m) => ({
    default: m.InteractionScreen,
  })),
);

const ApproveScreen = lazy(() =>
  import("./ApproveScreen.js").then((m) => ({ default: m.ApproveScreen })),
);

export function InteractionRoute() {
  return (
    <Suspense fallback={null}>
      <InteractionScreen />
    </Suspense>
  );
}

export function ApproveRoute() {
  return (
    <Suspense fallback={null}>
      <ApproveScreen />
    </Suspense>
  );
}
