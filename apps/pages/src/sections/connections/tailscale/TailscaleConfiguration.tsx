import { useState } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import {
  IconCopy,
  IconDownload,
  IconTrash,
  IconX,
} from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import type { TailscaleEditor } from "./useTailscaleApp.js";
export function TailscaleStatus({ model }: { model: TailscaleEditor }) {
  return (
    <>
      {model.busy ? (
        <IconKey label="Cancel Tailscale operation" onClick={model.cancel}>
          <IconX size={17} />
        </IconKey>
      ) : null}
      {model.failure ? <StatusMark tone="err" label={model.failure} /> : null}
      {model.result ? <StatusMark tone="ok" label={model.result} /> : null}
    </>
  );
}
function AppFields({
  model,
  callback,
}: { model: TailscaleEditor; callback: string }) {
  const disabled = model.busy || !!model.saved;
  return (
    <>
      <FieldShell
        label="App name"
        value={model.draft.name}
        disabled={disabled}
        onValueChange={(value) => model.changed("name", value)}
      />
      <FieldShell
        label="Tailscale API base URL"
        type="url"
        mono
        value={model.draft.apiBase}
        disabled={disabled}
        onValueChange={(value) => model.changed("apiBase", value)}
      />
      <FieldShell
        label="Tailnet"
        value={model.draft.tailnet}
        disabled={disabled}
        onValueChange={(value) => model.changed("tailnet", value)}
      />
      <FieldShell
        label="Provisioned node attributes"
        value={model.draft.allowedNodeAttributes.join(", ")}
        disabled={disabled}
        onValueChange={(value) => {
          model.clear();
          model.setDraft((current) => ({
            ...current,
            allowedNodeAttributes: value
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean),
          }));
        }}
      />
      <FieldShell
        label="Redirect URI to register"
        value={callback}
        type="url"
        mono
        readOnly
      />
    </>
  );
}
export function TailscaleSetupGuide() {
  return (
    <details className="conn-client-alt">
      <summary>Setup guide</summary>
      <p>
        Download this deployment's registration request and register it through
        Tailscale's documented admin API. Tailscale generates the vendor client
        ID and secret. Paste its returned app response to seal that secret in
        this vault.
      </p>
      <p>
        The hosted API currently restricts direct browser CORS access. This PWA
        uses no application backend or extension. Direct API controls execute
        the documented HTTP flow only when the provider endpoint admits this
        browser origin.
      </p>
      <p>
        The OAuth app requests only auth_keys:create:once. Same-tailnet users
        consent separately for each device. Optional node attributes must use
        the custom: prefix and apply only to devices provisioned through this
        OAuth app; ordinary browser sign-in does not assert them. Its token
        response is already a single-use auth key valid for one hour. Device
        enrollment is completed by the target device's Tailscale client.
      </p>
      <a
        href="https://tailscale.com/docs/features/oauth-apps/device-provisioning"
        target="_blank"
        rel="noreferrer noopener"
      >
        Tailscale OAuth app registration reference
      </a>
    </details>
  );
}
export function TailscaleConfiguration({
  model,
  callback,
  online,
}: { model: TailscaleEditor; callback: string; online: boolean }) {
  return (
    <section className="panel" aria-label="Tailscale OAuth app configuration">
      <FailureNotice
        id="tailscale-registration"
        title="Tailscale"
        message={model.failure}
      />
      <div className="panel__head">
        <h2>
          <span className="cx-step">2</span> Prepare Tailscale registration
        </h2>
      </div>
      <form
        className="cx-form panel__body"
        onSubmit={(event) => {
          event.preventDefault();
          model.download();
        }}
      >
        <AppFields model={model} callback={callback} />
        <TailscaleSetupGuide />
        <FormCommit
          label="Download registration request"
          icon={<IconDownload size={18} />}
          disabled={model.busy || !callback}
        >
          <IconKey
            label="Copy registration request"
            disabled={model.busy || !callback}
            onClick={() => {
              const request = model.artifact();
              if (!request) return;
              void navigator.clipboard
                ?.writeText(request)
                .catch(() =>
                  model.setFailure(
                    "Could not copy the Tailscale registration request.",
                  ),
                );
            }}
          >
            <IconCopy size={17} />
          </IconKey>
        </FormCommit>
        {!model.saved ? (
          <details className="conn-client-alt">
            <summary>Direct API registration</summary>
            <FieldShell
              label="Admin API access token"
              value={model.adminToken}
              type="password"
              autoComplete="off"
              disabled={model.busy}
              onValueChange={model.setAdminToken}
            />
            <FormCommit
              label="Register app with Tailscale"
              onClick={model.register}
              busy={model.busy}
              disabled={
                model.busy ||
                !model.ready ||
                !online ||
                !model.adminToken ||
                !callback
              }
            >
              <TailscaleStatus model={model} />
            </FormCommit>
          </details>
        ) : null}
      </form>
    </section>
  );
}
function RemoveAppKey({ model }: { model: TailscaleEditor }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <IconKey
        label={
          confirming
            ? "Confirm remove local Tailscale app configuration"
            : "Remove local Tailscale app configuration"
        }
        armed={confirming}
        disabled={model.busy}
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          model.forget();
          setConfirming(false);
        }}
      >
        <IconTrash size={17} />
      </IconKey>
      {confirming ? (
        <IconKey
          label="Keep Tailscale app configuration"
          disabled={model.busy}
          onClick={() => setConfirming(false)}
        >
          <IconX size={17} />
        </IconKey>
      ) : null}
    </>
  );
}
export function TailscaleAppImport({
  model,
  online,
}: { model: TailscaleEditor; online: boolean }) {
  return (
    <section
      className="panel"
      aria-label="Returned Tailscale app configuration"
    >
      <div className="panel__head">
        <h2>
          <span className="cx-step">3</span> Configure registered app
        </h2>
      </div>
      {model.saved ? (
        <div className="panel__body">
          <FieldShell
            label="Registered client ID"
            value={model.saved.id}
            readOnly
            mono
          />
          <details className="conn-client-alt">
            <summary>Direct API device authorization</summary>
            <p>
              Fresh user consent exchanges a code through the configured API.
              Pasted app credentials are unverified until that API accepts them.
            </p>
            <FormCommit
              label="Authorize a device with Tailscale"
              onClick={model.provision}
              busy={model.busy}
              disabled={model.busy || !online}
            >
              <RemoveAppKey model={model} />
              <TailscaleStatus model={model} />
            </FormCommit>
          </details>
        </div>
      ) : (
        <form
          className="cx-form panel__body"
          onSubmit={(event) => {
            event.preventDefault();
            model.importApp();
          }}
        >
          <FieldShell
            label="Returned OAuth app JSON"
            value={model.appResponse}
            type="password"
            autoComplete="off"
            disabled={model.busy}
            onValueChange={model.setAppResponse}
          />
          <FormCommit
            label="Save returned Tailscale app"
            disabled={model.busy || !model.ready || !model.appResponse}
          >
            <TailscaleStatus model={model} />
          </FormCommit>
        </form>
      )}
    </section>
  );
}
