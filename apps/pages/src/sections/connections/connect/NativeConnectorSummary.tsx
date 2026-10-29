import { nativeBrowserMethodPolicy } from "@opensesame/app-core/lib/native-browser-policy.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { errorText } from "@opensesame/app-core/sections/connections/shared.js";
import { useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconTrash, IconX } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { ConnectorPanel } from "./ConnectorPanel.js";
import {
  NativeAuthorizationControls,
  useNativeSignInUiLifetime,
} from "./NativeCancelSignIn.js";
import { NativeConnectorActions } from "./NativeConnectorActions.js";
import { NativeConnectorRecovery } from "./NativeConnectorRecovery.js";
import { Facts } from "./fields.js";
import type { NativeAuthorizationTicket } from "./native-connector-controller.js";
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
const LOCAL_STATUS_LABELS = {
  configuration: "Local configuration validation pending",
  authorizing: "Local configuration validation in progress",
  connected: "Local configuration validation pending",
  reauthorize: "Local configuration needs validation",
  cleanup: "Local configuration cleanup required",
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
  if (!nativeVerified(view))
    return view.configuration.method === "native-local"
      ? LOCAL_STATUS_LABELS[view.status]
      : STATUS_LABELS[view.status];
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
        ? "Managed by the provider"
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
  authorization?: NativeAuthorizationTicket | null;
};

function useNativeSummary(props: Props) {
  const {
    descriptor,
    controller,
    onChanged,
    onFlash,
    onRemoved,
    authorization,
  } = props;
  const lifetime = useNativeSignInUiLifetime(props);
  const initial = {
    owner: lifetime.owner,
    busy: false,
    confirming: false,
    failure: "",
  };
  const [stored, setStored] = useState(initial);
  const model = stored.owner === lifetime.owner ? stored : initial;
  const busy = model.busy || !!authorization?.current();
  const update = (patch: Partial<Omit<typeof initial, "owner">>) =>
    setStored((previous) => ({
      ...(previous.owner === lifetime.owner ? previous : initial),
      ...patch,
    }));
  async function perform(action: (current: () => boolean) => Promise<void>) {
    if (busy) return;
    const attempt = lifetime.begin();
    if (!attempt.current()) return;
    update({ busy: true, failure: "" });
    try {
      await action(attempt.current);
    } catch (error) {
      if (attempt.current()) {
        const text = nativeError(errorText(error), {});
        update({ failure: text });
        onFlash({ tone: "err", text });
      }
    } finally {
      try {
        if (attempt.current()) {
          update({ busy: false });
          const next = controller.load();
          if (attempt.current()) onChanged(next);
        }
      } finally {
        attempt.finish();
      }
    }
  }
  async function remove() {
    if (busy) return;
    if (!model.confirming) {
      update({ confirming: true });
      return;
    }
    update({ confirming: false });
    await perform(async (current) => {
      await controller.remove();
      if (!current()) return;
      onRemoved();
      if (!current()) return;
      onFlash({
        tone: "ok",
        text: `${descriptor.name} connection removed from this device.`,
      });
    });
  }
  return {
    ...model,
    busy,
    perform,
    remove,
    cancel: () => update({ confirming: false }),
  };
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
                ? view.configuration.method === "native-local"
                  ? "Previously validated configuration"
                  : `Previously verified ${view.identity.kind}`
                : view.configuration.method === "native-local"
                  ? "Configuration"
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
              view.configuration.method === "native-local"
                ? "Last local validation"
                : "Last provider verification",
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
    <ConnectorPanel
      id="complete"
      step={3}
      title={verified ? "Complete" : "Authorization"}
      label={`${descriptor.name} connection status`}
      focus
      actions={
        <StatusMark
          tone={verified ? "ok" : "warn"}
          label={verifiedLabel(view, descriptor.name)}
        />
      }
    >
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
          authorization={props.authorization}
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
    </ConnectorPanel>
  );
}
