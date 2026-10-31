import type { NativeConfigurationOwner } from "@opensesame/app-core/lib/native-connector-drivers.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconExternal, IconRefresh, IconX } from "../../../components/Icons.js";
import { nativeSignInRequired } from "./NativeConnectorFormOptions.js";
import type { NativeAuthorizationTicket } from "./native-connector-controller.js";
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

type NativeUiOwner = Readonly<{
  controllerIdentity: NativeConnectorController;
  providerId: string;
  connectionId: string | undefined;
  revision: number | undefined;
  fingerprint: string | undefined;
  roads: string;
}>;

function useNativeUiInvocation(
  owner: NativeUiOwner,
  latest: { readonly current: NativeUiOwner },
) {
  const mount = useRef<object | null>(null);
  const invocation = useRef<{
    controller: AbortController;
    owner: NativeUiOwner;
  } | null>(null);
  useEffect(() => {
    const lease = {};
    mount.current = lease;
    const stopLock = vaultStore.onLock(() => {
      invocation.current?.controller.abort();
      invocation.current = null;
    });
    return () => {
      stopLock();
      if (mount.current === lease) {
        mount.current = null;
        invocation.current?.controller.abort();
        invocation.current = null;
      }
    };
  }, []);
  useEffect(
    () => () => {
      const pending = invocation.current;
      if (pending?.owner === owner) {
        pending.controller.abort();
        invocation.current = null;
      }
    },
    [owner],
  );
  const begin = () => {
    const lease = mount.current;
    invocation.current?.controller.abort();
    const token = { controller: new AbortController(), owner };
    invocation.current = token;
    return {
      signal: token.controller.signal,
      current: () =>
        !token.controller.signal.aborted &&
        lease !== null &&
        mount.current === lease &&
        latest.current === owner &&
        invocation.current === token,
      finish: () => {
        if (invocation.current === token) invocation.current = null;
      },
    };
  };
  return begin;
}

/** A captured pending form attempt is the transient configure caller, never saved authority. */
export function nativeConfigurationOwner(attempt: {
  readonly signal: AbortSignal;
  current(): boolean;
}): NativeConfigurationOwner {
  return Object.freeze({
    signal: attempt.signal,
    assertCurrent: () => {
      if (!attempt.current())
        throw new DOMException("This configuration ended.", "AbortError");
    },
  });
}

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
  const begin = useNativeUiInvocation(owner, latest);
  return { owner, begin };
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
        label={
          method?.id === "native-local"
            ? `Verify ${descriptor.name} configuration`
            : `Verify ${descriptor.name} access`
        }
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
