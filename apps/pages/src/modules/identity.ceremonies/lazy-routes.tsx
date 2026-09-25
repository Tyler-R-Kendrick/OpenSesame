/**
 * `/i/:ref`, `/approve/:ref` and `/invoke/:kind` as route elements whose
 * screens arrive only when their route opens (ADR 0140 plan steps 9–10): the
 * interaction ceremony, the approval review, the WebAuthn port they run and
 * the authenticator hand-off are split out of the ceremonies module, so
 * `/device` and `/claim` never load them.
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

const InvokeScreen = lazy(() =>
  import("./InvokeScreen.js").then((m) => ({ default: m.InvokeScreen })),
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

export function InvokeRoute() {
  return (
    <Suspense fallback={null}>
      <InvokeScreen />
    </Suspense>
  );
}
