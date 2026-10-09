import { nativeBrowserMethodPolicy } from "@opensesame/app-core/lib/native-browser-policy.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { errorText } from "@opensesame/app-core/sections/connections/shared.js";
import { useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import {
  IconExternal,
  IconRefresh,
  IconTrash,
  IconX,
} from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { NativeConnectorActions } from "./NativeConnectorActions.js";
import { NativeConnectorRecovery } from "./NativeConnectorRecovery.js";
import { Facts } from "./fields.js";
import { nativeError, nativeVerified } from "./native-connector-ui-values.js";
import type {
  NativeConnectorCallbacks,
  NativeConnectorController,
  NativeConnectorDescriptor,
} from "./native-connector-ui.js";

const STATUS_LABELS = {
  configuration: "Provider verification pending",
  authorizing: "Provider authorization in progress",
  connected: "Provider verification pending",
  reauthorize: "Provider authorization needs renewal",
  cleanup: "Provider cleanup required",
};

function verifiedLabel(view: NativeConnectorView, name: string) {
  const policy = nativeBrowserMethodPolicy(
    view.providerId,
    view.configuration.method,
    view.configuration.parameters,
  );
  if (view.status !== "cleanup" && !policy.available)
    return (
      policy.reason ?? "This provider route is unavailable in this browser."
    );
  if (!nativeVerified(view)) return STATUS_LABELS[view.status];
  if (view.configuration.method === "native-local")
    return `${name} configuration verified`;
  if (!view.identity || view.identity.assurance === "credential-valid")
    return `${name} access verified`;
  return `${name} connected`;
}

function nativeTargetRows(
  targets: NativeConnectorView["targets"],
): [string, string][] {
  return targets.map((target) => [
    target.id === target.label
      ? target.kind === "api"
        ? "API endpoint"
        : target.kind
      : `${target.kind} · ${target.id}`,
    target.label,
  ]);
}

function NativeGrantFacts({ view }: { view: NativeConnectorView }) {
  return view.grants.map((grant) => (
    <section className="cx-block cx-form" key={grant.actor}>
      <h3>{grant.label}</h3>
      <Facts rows={nativeGrantRows(grant, nativeVerified(view))} />
    </section>
  ));
}

function nativeGrantRows(
  grant: NativeConnectorView["grants"][number],
  verified: boolean,
): [string, string][] {
  const permissions =
    grant.permissionState === "known"
      ? grant.grantedScopes.join(", ") || "No scopes returned"
      : grant.permissionState === "provider-managed"
        ? "Managed by the provider's key settings"
        : "Provider did not report granted permissions";
  const rows: [string, string][] = [
    ["Permissions", permissions],
    [
      "Authorization",
      grant.needsReauth ||
      (grant.expiresAt !== null && grant.expiresAt <= Date.now())
        ? "Authorize again"
        : verified
          ? "Verified"
          : "Verification pending",
    ],
  ];
  rows.push([
    "Expires",
    grant.expiresAt === null
      ? "Not reported by the provider"
      : new Date(grant.expiresAt).toISOString(),
  ]);
  return rows;
}

function NativeConfigurationFacts({
  descriptor,
  view,
}: {
  descriptor: NativeConnectorDescriptor;
  view: NativeConnectorView;
}) {
  const method = descriptor.methods.find(
    (item) => item.id === view.configuration.method,
  );
  const rows: [string, string][] = Object.entries(
    view.configuration.parameters,
  ).map(([id, value]) => [
    method?.fields.find((field) => field.id === id && !field.secret)?.label ??
      id,
    value,
  ]);
  if (view.configuration.clientId)
    rows.push(["Public client ID", view.configuration.clientId]);
  return rows.length ? <Facts rows={rows} /> : null;
}

type Props = NativeConnectorCallbacks & {
  descriptor: NativeConnectorDescriptor;
  controller: NativeConnectorController;
  view: NativeConnectorView;
  onRemoved: () => void;
};

function useNativeSummary({
  descriptor,
  controller,
  onChanged,
  onFlash,
  onRemoved,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState("");
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      await action();
    } catch (error) {
      const text = nativeError(errorText(error), {});
      setFailure(text);
      onFlash({ tone: "err", text });
    } finally {
      setBusy(false);
      onChanged(controller.load());
    }
  }
  async function remove() {
    if (busy) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    await perform(async () => {
      await controller.remove();
      onRemoved();
      onFlash({
        tone: "ok",
        text: `${descriptor.name} connection removed from this device.`,
      });
    });
    setConfirming(false);
  }
  return {
    busy,
    confirming,
    failure,
    perform,
    remove,
    cancel: () => setConfirming(false),
  };
}

function NativeAuthorizationControls({
  descriptor,
  controller,
  view,
  busy,
  perform,
}: {
  descriptor: NativeConnectorDescriptor;
  controller: NativeConnectorController;
  view: NativeConnectorView;
  busy: boolean;
  perform: (action: () => Promise<void>) => Promise<void>;
}) {
  const method = descriptor.methods.find(
    (item) => item.id === view.configuration.method && item.available,
  );
  const authorizes = method?.id === "oauth" || method?.id === "mcp";
  const groups = method?.scopeGroups ?? [];
  return (
    <div className="cx-form">
      {authorizes &&
      view.status !== "connected" &&
      view.status !== "cleanup" ? (
        <div className="cx-links">
          {groups.length > 0 ? (
            groups.map((group) => (
              <IconKey
                label={`Authorize ${group.label}`}
                key={group.actor}
                disabled={busy}
                onClick={() =>
                  void perform(() => controller.authorize(group.actor))
                }
              >
                <IconExternal size={16} />
              </IconKey>
            ))
          ) : (
            <IconKey
              label={`Authorize ${descriptor.name}`}
              disabled={busy}
              onClick={() => void perform(() => controller.authorize())}
            >
              <IconExternal size={16} />
            </IconKey>
          )}
        </div>
      ) : null}
      <IconKey
        label={`Verify ${descriptor.name} access`}
        disabled={busy || !method || view.status === "cleanup"}
        onClick={() =>
          void perform(async () => {
            await controller.verify();
          })
        }
      >
        <IconRefresh size={16} />
      </IconKey>
    </div>
  );
}

function NativeIdentityFacts({
  view,
  verified,
}: {
  view: NativeConnectorView;
  verified: boolean;
}) {
  return (
    <>
      {view.identity ? (
        <Facts
          rows={[
            [
              !verified
                ? `Previously verified ${view.identity.kind}`
                : view.identity.assurance === "credential-valid"
                  ? "Verified access"
                  : view.identity.kind,
              view.identity.label,
            ],
          ]}
        />
      ) : null}
      {!verified && view.verifiedAt !== null ? (
        <Facts
          rows={[
            [
              "Last provider verification",
              new Date(view.verifiedAt).toISOString(),
            ],
          ]}
        />
      ) : null}
      {view.targets.length > 0 ? (
        <Facts rows={nativeTargetRows(view.targets)} />
      ) : null}
    </>
  );
}

export function NativeConnectorSummary(props: Props) {
  const { descriptor, controller, view, onChanged, onFlash } = props;
  const model = useNativeSummary(props);
  const verified = nativeVerified(view);
  return (
    <section
      className="panel"
      id="complete"
      aria-label={`${descriptor.name} connection status`}
    >
      <div className="panel__head">
        <h2>
          <span className="cx-step">3</span>{" "}
          {verified ? "Complete" : "Authorization"}
        </h2>
        <StatusMark
          tone={verified ? "ok" : "warn"}
          label={verifiedLabel(view, descriptor.name)}
        />
      </div>
      <div className="panel__body cx-form">
        <p>{view.configuration.displayName}</p>
        <NativeConfigurationFacts descriptor={descriptor} view={view} />
        <NativeIdentityFacts view={view} verified={verified} />
        <NativeGrantFacts view={view} />
        <NativeAuthorizationControls
          descriptor={descriptor}
          controller={controller}
          view={view}
          busy={model.busy}
          perform={model.perform}
        />
        <NativeConnectorRecovery
          view={view}
          controller={controller}
          disabled={model.busy}
          onChanged={onChanged}
          onFlash={onFlash}
        />
        <NativeConnectorActions
          descriptor={descriptor}
          controller={controller}
          view={view}
          disabled={model.busy}
          onChanged={onChanged}
          onFlash={onFlash}
        />
        {model.failure ? <StatusMark tone="err" label={model.failure} /> : null}
        {descriptor.disconnectExplanation ? (
          <details className="cx-application">
            <summary>Provider disconnection guide</summary>
            <p>{descriptor.disconnectExplanation}</p>
          </details>
        ) : null}
        <div className="cx-links">
          <IconKey
            label={
              model.confirming ? "Confirm remove connector" : "Remove connector"
            }
            armed={model.confirming}
            disabled={model.busy}
            onClick={() => void model.remove()}
          >
            <IconTrash size={16} />
          </IconKey>
          {model.confirming ? (
            <IconKey
              label="Cancel removal"
              disabled={model.busy}
              onClick={model.cancel}
            >
              <IconX size={16} />
            </IconKey>
          ) : null}
        </div>
      </div>
    </section>
  );
}
