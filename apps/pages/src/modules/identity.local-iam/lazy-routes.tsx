/**
 * `/identity/authorize` as a route element whose screen arrives only when
 * that route opens. `?cli=1` loads only the daemon panel; every other query
 * loads application sign-in consent.
 */

import { Suspense, lazy } from "react";
import { useLocation } from "react-router";

const LocalAuthorizeScreen = lazy(() =>
  import("./AuthorizeConsentScreen.js").then((m) => ({
    default: m.LocalAuthorize,
  })),
);

const CliAuthorizePanel = lazy(() =>
  import("./cli-authorize-panel.js").then((m) => ({
    default: m.CliAuthorizePanel,
  })),
);

export function LocalAuthorizeRoute() {
  const { search } = useLocation();
  const cli = new URLSearchParams(search).get("cli") === "1";
  if (cli) {
    return (
      <Suspense fallback={null}>
        <CliAuthorizePanel />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <LocalAuthorizeScreen />
    </Suspense>
  );
}
