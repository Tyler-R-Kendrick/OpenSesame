import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconExternal, IconRefresh, IconX } from "../../../components/Icons.js";
import { nativeSignInRequired } from "./NativeConnectorFormOptions.js";
import type { NativeAuthorizationTicket } from "./native-connector-controller.js";
import {
  nativeInitialMethod,
  nativeInitialValues,
} from "./native-connector-edit-values.js";
import { nativeScopeDefaults } from "./native-connector-ui-values.js";
import type {
  NativeConnectorController,
  NativeConnectorDescriptor,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";

type NativeUiScope = {
  descriptor: NativeConnectorDescriptor;
  controller: NativeConnectorController;
  view?: NativeConnectorView | null;
};

/** A UI invocation belongs to one mount lease and semantic owner, never a popup ticket. */
export function useNativeSignInUiLifetime({
  descriptor,
  controller,
  view,
}: NativeUiScope) {
  const roads = descriptor.methods
    .map((method) => `${method.id}:${method.available}`)
    .join("/");
  const providerId = descriptor.providerId;
  const connectionId = view?.connectionId;
  const revision = view?.revision;
  const fingerprint = view?.fingerprint;
  const owner = useMemo(
    () => ({
      controllerIdentity: controller,
      providerId,
      connectionId,
      revision,
      fingerprint,
      roads,
    }),
    [controller, providerId, connectionId, revision, fingerprint, roads],
  );
  const latest = useRef(owner);
  latest.current = owner;
  const mount = useRef<object | null>(null);
  const invocation = useRef<object | null>(null);
  useEffect(() => {
    const lease = {};
    mount.current = lease;
    return () => {
      if (mount.current === lease) {
        mount.current = null;
        invocation.current = null;
      }
    };
  }, []);
  const begin = () => {
    const lease = mount.current;
    const token = {};
    invocation.current = token;
    return {
      current: () =>
        lease !== null &&
        mount.current === lease &&
        latest.current === owner &&
        invocation.current === token,
      finish: () => {
        if (invocation.current === token) invocation.current = null;
      },
    };
  };
  return { owner, begin };
}

type NativeFormSeed = {
  setMethodId: (id: NativeMethodDescriptor["id"] | undefined) => void;
  setValues: (values: ReturnType<typeof nativeInitialValues>) => void;
  setScopes: (scopes: ReturnType<typeof nativeScopeDefaults>) => void;
  setName: (name: string) => void;
  setIcon: (icon: string) => void;
};

/**
 * A saved revision that changes under the form (another tab, a verified
 * action) re-seeds the fields, as remounting on revision once did. While an
 * authorization is pending the form must not reset, or its Cancel sign-in
 * would vanish; the reseed lands once busy clears.
 */
export function useNativeRevisionSync(
  descriptor: NativeConnectorDescriptor,
  view: NativeConnectorView | null | undefined,
  frozen: boolean,
  seed: NativeFormSeed,
) {
  const revisionKey = view
    ? `${view.connectionId}/${view.revision}/${view.configuration.fingerprint}`
    : null;
  const syncedRevision = useRef(revisionKey);
  useEffect(() => {
    if (
      !view ||
      !revisionKey ||
      syncedRevision.current === revisionKey ||
      frozen
    )
      return;
    syncedRevision.current = revisionKey;
    const next = nativeInitialMethod(descriptor, view);
    seed.setMethodId(next?.id);
    seed.setValues(next ? nativeInitialValues(next, view) : {});
    seed.setScopes(
      next ? nativeScopeDefaults(next, view.configuration.requestedScopes) : {},
    );
    seed.setName(view.configuration.displayName);
    seed.setIcon(view.configuration.icon ?? "");
  }, [descriptor, view, revisionKey, frozen, seed]);
}

export function useNativeFormFeedback(
  props: NativeUiScope & { authorization?: NativeAuthorizationTicket | null },
) {
  const { authorization } = props;
  const lifetime = useNativeSignInUiLifetime(props);
  const [busyOwner, setBusyOwner] = useState<object | null>(null);
  const busy = busyOwner === lifetime.owner || !!authorization?.current();
  const [failureState, setFailureState] = useState<{
    owner: object;
    text: string;
  } | null>(null);
  const failure =
    failureState?.owner === lifetime.owner ? failureState.text : "";
  const setFailure = (text: string) =>
    setFailureState({ owner: lifetime.owner, text });
  return { lifetime, busy, setBusyOwner, failure, setFailure };
}

/** COOP isolates the provider window; this key closes only the originating sign-in. */
export function NativeCancelSignIn({
  busy,
  method,
  view,
  onCancel,
  authorization,
}: {
  busy: boolean;
  method?: NativeMethodDescriptor;
  view?: NativeConnectorView | null;
  onCancel: () => void;
  authorization?: NativeAuthorizationTicket | null;
}) {
  if (authorization !== undefined) {
    if (!authorization?.current()) return null;
  } else if (!busy || !method || !nativeSignInRequired(method, view))
    return null;
  return (
    <IconKey label="Cancel sign-in" onClick={authorization?.cancel ?? onCancel}>
      <IconX size={16} />
    </IconKey>
  );
}

export function NativeAuthorizationControls({
  descriptor,
  controller,
  view,
  busy,
  perform,
  authorization,
}: {
  descriptor: NativeConnectorDescriptor;
  controller: NativeConnectorController;
  view: NativeConnectorView;
  busy: boolean;
  perform: (action: (current: () => boolean) => Promise<void>) => Promise<void>;
  authorization?: NativeAuthorizationTicket | null;
}) {
  const method = descriptor.methods.find(
    (item) => item.id === view.configuration.method && item.available,
  );
  const authorizes = method ? nativeSignInRequired(method) : false;
  const groups = method?.scopeGroups ?? [];
  const lifetime = useNativeSignInUiLifetime({ descriptor, controller, view });
  const [authorizingOwner, setAuthorizingOwner] = useState<object | null>(null);
  const authorizing = authorizingOwner === lifetime.owner;
  async function authorize(actor?: string) {
    if (busy) return;
    const attempt = lifetime.begin();
    if (!attempt.current()) return;
    setAuthorizingOwner(lifetime.owner);
    try {
      await perform(() => controller.authorize(actor));
    } finally {
      if (attempt.current()) setAuthorizingOwner(null);
      attempt.finish();
    }
  }
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
                onClick={() => void authorize(group.actor)}
              >
                <IconExternal size={16} />
              </IconKey>
            ))
          ) : (
            <IconKey
              label={`Authorize ${descriptor.name}`}
              disabled={busy}
              onClick={() => void authorize()}
            >
              <IconExternal size={16} />
            </IconKey>
          )}
        </div>
      ) : null}
      <NativeCancelSignIn
        busy={authorizing}
        method={method}
        onCancel={controller.cancelAuthorization}
        authorization={authorization === undefined ? undefined : null}
      />
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
