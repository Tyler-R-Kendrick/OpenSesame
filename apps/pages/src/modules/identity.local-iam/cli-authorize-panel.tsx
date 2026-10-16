import { readCliAppIntegrationBearer } from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
import { Suspense, lazy, useState } from "react";

const CliAuthorizePairingForm = lazy(() =>
  import("./cli-authorize-pairing-form.js").then((m) => ({
    default: m.CliAuthorizePairingForm,
  })),
);

const CliAuthorizePairedPanel = lazy(() =>
  import("./cli-authorize-paired-panel.js").then((m) => ({
    default: m.CliAuthorizePairedPanel,
  })),
);

export function CliAuthorizePanel() {
  const [paired, setPaired] = useState(
    () => readCliAppIntegrationBearer() !== null,
  );

  return (
    <section className="panel" aria-label="Authorize CLI">
      <div className="panel__head">
        <h1>Authorize CLI</h1>
      </div>
      <div className="panel__body">
        {paired ? (
          <Suspense fallback={<output>Reading CLI request…</output>}>
            <CliAuthorizePairedPanel />
          </Suspense>
        ) : (
          <Suspense fallback={null}>
            <CliAuthorizePairingForm onPaired={() => setPaired(true)} />
          </Suspense>
        )}
      </div>
    </section>
  );
}
