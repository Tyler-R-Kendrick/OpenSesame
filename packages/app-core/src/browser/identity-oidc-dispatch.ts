/** Original factory, actor and browser window are retained before cold private hydration. */
import type { IdentityConnectionDraft } from "../lib/identity-connections-schema.js";
import {
  getIdentityConnectionRuntime,
  hydrateIdentityConnections,
} from "../lib/identity-connections-store.js";
import { requireValidIdentityConnection } from "../lib/identity-connections-validation.js";
import { captureNativeIdentityOwner } from "../lib/identity-native-owner.js";
import {
  isNativeOidcConfiguration,
  usesNativeOidcTransport,
} from "../lib/identity-oidc-config.js";
import {
  type IdentityBrowserNode,
  type IdentityBrowserNodeOwner,
  reserveIdentityBrowserNode,
} from "../lib/tailscale/browser-node-identity-port.js";
import { page } from "../ports.js";
import {
  enrollIdentityBrowserNode,
  retireIdentityBrowserNode as retire,
} from "./identity-browser-node-enrollment.js";
import {
  captureIdentityConfigurationActor,
  saveCapturedIdentityConfiguration,
} from "./identity-configuration-publication.js";
import {
  type NativeAuthPopup,
  resumeNativeAuthPopup,
} from "./native-auth-session.js";
import {
  type BrowserOidcHTTP,
  captureBrowserOidcHTTP,
} from "./oidc/browser-transport.js";
export {
  nativeIdentityPeering as nativeOidcPeering,
  subscribeNativeIdentityPeering as subscribeNativeOidcPeering,
} from "./identity-browser-node-enrollment.js";

/** Reserve native activation before hydration, but open only the saved/selected carrier. */
function captureOidcCarrier(owner: IdentityBrowserNodeOwner) {
  const openNode = reserveIdentityBrowserNode(owner);
  let node: IdentityBrowserNode | null = null;
  let browser: BrowserOidcHTTP | null = null;
  let opened = false;
  return Object.freeze({
    snapshot: () => node?.snapshot(),
    connect: async (draft: IdentityConnectionDraft) => {
      owner.assertCurrent();
      if (opened)
        throw new Error("Original OIDC HTTP carrier was already opened");
      opened = true;
      if (usesNativeOidcTransport(draft)) {
        node = openNode();
        return (
          await enrollIdentityBrowserNode(node, owner, draft.name)
        ).captureNativeHTTP(owner.signal);
      }
      browser = captureBrowserOidcHTTP(owner);
      return browser.transport;
    },
    retire: async () => {
      if (browser) await browser.retire();
      else await retire(node);
    },
  });
}
/** Public OIDC can release this unused capture without requiring Networking or opening a Worker. */
export function captureOidcConfiguration(existingId?: string) {
  const actor = captureIdentityConfigurationActor(existingId, "enrollment");
  const nodeOwner = Object.freeze({
    signal: actor.signal,
    assertCurrent: actor.assertActor,
  });
  const carrier = captureOidcCarrier(nodeOwner);
  let checked = false;
  const assertActor = () => {
    actor.assertActor();
    carrier.snapshot();
  };
  const owner = Object.freeze({
    signal: actor.signal,
    assertActor,
    assertCurrent: () => {
      actor.assertCurrent();
      carrier.snapshot();
    },
    clearOwnSession: () => {
      assertActor();
      actor.clearOwnSession();
      carrier.snapshot();
    },
    check: async (draft: IdentityConnectionDraft) => {
      actor.assertCurrent();
      if (checked)
        throw new Error("Original identity configuration was already checked");
      checked = true;
      await hydrateIdentityConnections();
      actor.assertCurrent();
      const transport = await carrier.connect(draft);
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
      await carrier.retire();
      actor.assertCurrent();
      return result;
    },
    release: async () => {
      try {
        await carrier.retire();
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
  const carrier = captureOidcCarrier(pendingOwner);
  let popup: ReturnType<typeof retainPopup> | null = null;
  let failed = false;
  try {
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
    const transport = await carrier.connect(draft);
    owner.assertPending();
    const { signInConfiguredNativeOidc } = await import(
      "./oidc/configured-runtime.js"
    );
    owner.assertPending();
    await signInConfiguredNativeOidc(
      connectionId,
      draft,
      owner,
      popup,
      transport,
      carrier.retire,
    );
  } catch (error) {
    failed = true;
    try {
      await carrier.retire();
    } catch (cleanup) {
      if (
        error === cleanup ||
        (error instanceof AggregateError && error.errors.includes(cleanup))
      )
        throw error;
      throw new AggregateError(
        [error, cleanup],
        "OIDC failed and its original carrier retirement also failed",
        { cause: error },
      );
    } finally {
      owner.release();
      popup?.cancel();
    }
    throw error;
  } finally {
    if (!failed) await carrier.retire();
  }
}
