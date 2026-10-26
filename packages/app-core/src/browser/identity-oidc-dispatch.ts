/** Original node, actor and browser window are retained before cold private hydration. */
import type { IdentityConnectionDraft } from "../lib/identity-connections-schema.js";
import {
  getIdentityConnectionRuntime,
  hydrateIdentityConnections,
} from "../lib/identity-connections-store.js";
import { requireValidIdentityConnection } from "../lib/identity-connections-validation.js";
import { captureNativeIdentityOwner } from "../lib/identity-native-owner.js";
import { isNativeOidcConfiguration } from "../lib/identity-oidc-config.js";
import {
  type IdentityBrowserNode,
  type IdentityBrowserNodeOwner,
  captureIdentityBrowserNode,
} from "../lib/tailscale/browser-node-identity-port.js";
import { page } from "../ports.js";
import {
  captureIdentityConfigurationActor,
  saveCapturedIdentityConfiguration,
} from "./identity-configuration-publication.js";
import {
  type NativeAuthPopup,
  resumeNativeAuthPopup,
} from "./native-auth-session.js";

export {
  nativeIdentityPeering as nativeOidcPeering,
  subscribeNativeIdentityPeering as subscribeNativeOidcPeering,
} from "./identity-browser-node-enrollment.js";
import {
  enrollIdentityBrowserNode,
  retireIdentityBrowserNode as retire,
} from "./identity-browser-node-enrollment.js";
async function connect(
  node: IdentityBrowserNode | null,
  owner: IdentityBrowserNodeOwner,
  label: string,
) {
  return (
    await enrollIdentityBrowserNode(node, owner, label)
  ).captureNativeHTTP(owner.signal);
}
/** Public OIDC can release this unused capture without requiring Networking or opening a Worker. */
export function captureOidcConfiguration(existingId?: string) {
  const actor = captureIdentityConfigurationActor(existingId, "enrollment");
  const nodeOwner = Object.freeze({
    signal: actor.signal,
    assertCurrent: actor.assertActor,
  });
  const node = captureIdentityBrowserNode(nodeOwner);
  let checked = false;
  const assertActor = () => {
    actor.assertActor();
    node?.snapshot();
  };
  const owner = Object.freeze({
    signal: actor.signal,
    assertActor,
    assertCurrent: () => {
      actor.assertCurrent();
      node?.snapshot();
    },
    clearOwnSession: () => {
      assertActor();
      actor.clearOwnSession();
      node?.snapshot();
    },
    check: async (draft: IdentityConnectionDraft) => {
      actor.assertCurrent();
      if (checked)
        throw new Error("Original identity configuration was already checked");
      checked = true;
      await hydrateIdentityConnections();
      actor.assertCurrent();
      const transport = await connect(node, nodeOwner, draft.name);
      actor.assertCurrent();
      const { testConfiguredNativeOidc } = await import(
        "./oidc/configured-runtime.js"
      );
      actor.assertCurrent();
      const result = await testConfiguredNativeOidc(
        draft,
        { signal: actor.signal, assertCurrent: owner.assertCurrent },
        transport,
      );
      actor.assertCurrent();
      await retire(node);
      actor.assertCurrent();
      return result;
    },
    release: async () => {
      try {
        await retire(node);
      } finally {
        actor.release();
      }
    },
  });
  return owner;
}
export const saveConfiguredNativeOidc = saveCapturedIdentityConfiguration;
function retainPopup(popup: NativeAuthPopup) {
  const wait = popup.wait;
  const cancel = popup.cancel;
  const check = () => {
    if (popup.wait !== wait || popup.cancel !== cancel)
      throw new Error("Original OIDC window changed");
  };
  return Object.freeze({
    wait: (request: Parameters<typeof wait>[0]) => {
      check();
      const result = wait.call(popup, request);
      check();
      return result;
    },
    cancel: () => cancel.call(popup),
  });
}
/** Called in the original click before hydration, private credential reads or runtime imports. */
export async function beginSavedNativeOidc(
  connectionId: string,
): Promise<void> {
  const owner = captureNativeIdentityOwner(connectionId, "oidc");
  const pendingOwner = Object.freeze({
    signal: owner.signal,
    assertCurrent: owner.assertPending,
  });
  let node: IdentityBrowserNode | null = null;
  let popup: ReturnType<typeof retainPopup> | null = null;
  try {
    node = captureIdentityBrowserNode(pendingOwner);
    if (!node)
      throw new Error("Enable Networking before native identity sign-in");
    const window = page().open(
      "about:blank",
      "_blank",
      "popup,width=600,height=720",
    );
    if (!window)
      throw new Error("Allow the identity sign-in window and try again");
    popup = retainPopup(resumeNativeAuthPopup(window));
    owner.assertPending();
    await hydrateIdentityConnections();
    owner.assertPending();
    const draft = getIdentityConnectionRuntime(connectionId);
    if (!draft || !isNativeOidcConfiguration(draft))
      throw new Error("Saved native OIDC configuration changed");
    requireValidIdentityConnection(draft);
    owner.bindConfiguration(draft);
    const transport = await connect(node, pendingOwner, draft.name);
    owner.assertPending();
    const { signInConfiguredNativeOidc } = await import(
      "./oidc/configured-runtime.js"
    );
    owner.assertPending();
    const originalNode = node;
    await signInConfiguredNativeOidc(
      connectionId,
      draft,
      owner,
      popup,
      transport,
      () => retire(originalNode),
    );
  } catch (error) {
    owner.release();
    popup?.cancel();
    throw error;
  } finally {
    await retire(node);
  }
}
