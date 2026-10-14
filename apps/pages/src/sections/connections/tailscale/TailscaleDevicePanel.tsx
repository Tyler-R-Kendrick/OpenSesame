import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconCopy } from "../../../components/Icons.js";
import { TailscaleStatus } from "./TailscaleConfiguration.js";
import type { TailscaleEditor } from "./useTailscaleApp.js";
function IssuedKey({ model }: { model: TailscaleEditor }) {
  const key = model.key;
  if (!key) return null;
  return (
    <section className="panel" aria-label="Tailscale device key handoff">
      <div className="panel__head">
        <h2>Enroll the target device</h2>
      </div>
      <div className="panel__body">
        <FieldShell
          label={
            key.singleUse ? "Single-use auth key" : "Unverified device auth key"
          }
          type="password"
          mono
          readOnly
          value={key.key}
          tail={
            <IconKey
              label="Copy Tailscale device auth key"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(key.key)
                  .catch(() => undefined);
              }}
            >
              <IconCopy size={17} />
            </IconKey>
          }
        />
        {key.expiresAt ? (
          <p>
            This one-use key expires at{" "}
            {new Date(key.expiresAt).toLocaleTimeString()}.
          </p>
        ) : (
          <p>
            This pasted key's validity, expiry and reuse policy are unverified.
            Follow the limits shown by Tailscale when it issued the key.
          </p>
        )}
        <p>
          Use the copied key with tailscale up --auth-key on the target device.
          Device enrollment is completed by that device's Tailscale client.
        </p>
        <FormCommit label="Dismiss device auth key" onClick={model.cancel} />
      </div>
    </section>
  );
}
export function TailscaleDevicePanel({ model }: { model: TailscaleEditor }) {
  return (
    <>
      <section className="panel" aria-label="Tailscale device provisioning">
        <div className="panel__head">
          <h2>
            <span className="cx-step">4</span> Device auth key
          </h2>
        </div>
        <form
          className="cx-form panel__body"
          onSubmit={(event) => {
            event.preventDefault();
            model.handoff();
          }}
        >
          <FieldShell
            label="Issued device auth key"
            type="password"
            autoComplete="off"
            value={model.deviceKey}
            disabled={model.busy}
            onValueChange={model.setDeviceKey}
          />
          <details className="conn-client-alt">
            <summary>Device handoff</summary>
            <p>
              Provide a key issued by Tailscale through your authorized account.
              This browser does not contact a helper, run a process, verify a
              pasted key or claim that a device has enrolled.
            </p>
            <a
              href="https://console.tailscale.com/admin/settings/keys"
              target="_blank"
              rel="noreferrer noopener"
            >
              Open Tailscale keys
            </a>
          </details>
          <FormCommit
            label="Prepare device key handoff"
            disabled={model.busy || !model.ready || !model.deviceKey}
          >
            <TailscaleStatus model={model} />
          </FormCommit>
        </form>
      </section>
      <IssuedKey model={model} />
    </>
  );
}
