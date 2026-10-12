import { cliAuthorizeUi } from "./cli-authorize-ui.js";

const ui = cliAuthorizeUi;

export function CliAuthorizeProofUnavailable() {
  return (
    <section className="panel" aria-label={ui.sheetTitle}>
      <div className="panel__head">
        <h1>{ui.sheetTitle}</h1>
      </div>
      <div className="panel__body">
        <p>Unlock with a PIN or passkey on this device first.</p>
      </div>
    </section>
  );
}
