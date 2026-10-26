import type { IdentityConnectionDraft } from "../lib/identity-connections-schema.js";
import {
  getIdentityConnectionRuntime,
  hydrateIdentityConnections,
  readIdentityConnection,
} from "../lib/identity-connections-store.js";
import { requireValidIdentityConnection } from "../lib/identity-connections-validation.js";
import { captureNativeIdentityOwner } from "../lib/identity-native-owner.js";
import { captureNativeProviderAuthority } from "../lib/native-connector-transport.js";
import { page } from "../ports.js";
import { captureIdentityConfigurationActor } from "./identity-configuration-publication.js";
import { resumeNativeAuthPopup } from "./native-auth-session.js";
import type { SamlPostOwner } from "./saml/assertion-conditions.js";

function captureOriginalRoute(metadataUrl: string | null) {
  if (metadataUrl === "") return undefined;
  try {
    return captureNativeProviderAuthority().capture();
  } catch (error) {
    if (metadataUrl !== null) throw error;
    return undefined;
  }
}
function captureMetadataRoute(
  metadataUrl: string | null,
  owner: SamlPostOwner,
) {
  const transport = captureOriginalRoute(metadataUrl);
  const stop = new AbortController();
  const requests = new Set<Promise<Response>>();
  let retired = false;
  const assertAuthority = () => {
    owner.signal.throwIfAborted();
    transport?.assertCurrent();
  };
  const assertCurrent = () => {
    owner.assertCurrent();
    assertAuthority();
  };
  assertCurrent();
  return Object.freeze({
    assertCurrent,
    assertAuthority,
    transport:
      transport &&
      Object.freeze({
        signal: AbortSignal.any([
          owner.signal,
          stop.signal,
          ...(transport.signal ? [transport.signal] : []),
        ]),
        assertCurrent,
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          assertCurrent();
          if (retired)
            throw new Error("The original SAML metadata route retired");
          const pending = transport.fetch(input, {
            ...init,
            signal: AbortSignal.any([
              owner.signal,
              stop.signal,
              ...(init?.signal ? [init.signal] : []),
              ...(transport.signal ? [transport.signal] : []),
            ]),
          });
          requests.add(pending);
          void pending.then(
            () => requests.delete(pending),
            () => requests.delete(pending),
          );
          return pending;
        },
      }),
    retire: async () => {
      retired = true;
      stop.abort();
      await Promise.allSettled([...requests]);
    },
  });
}
/** A configuration test proves configuration only, against its original local actor. */
export function captureSamlConfiguration(
  metadataUrl: string,
  existingId?: string,
) {
  const actor = captureIdentityConfigurationActor(existingId);
  const pending = { signal: actor.signal, assertCurrent: actor.assertCurrent };
  const route = captureMetadataRoute(metadataUrl, pending);
  const assertActor = () => {
    actor.assertActor();
    route.assertAuthority();
    actor.assertActor();
  };
  return Object.freeze({
    assertCurrent: route.assertCurrent,
    assertActor,
    clearOwnSession: () => {
      assertActor();
      actor.clearOwnSession(route.assertAuthority);
      assertActor();
    },
    check: async (draft: IdentityConnectionDraft) => {
      route.assertCurrent();
      if (draft.samlMetadataUrl !== metadataUrl)
        throw new Error("Original SAML metadata target changed");
      const { testNativeSamlConfiguration } = await import(
        "./saml/configured-runtime.js"
      );
      route.assertCurrent();
      return testNativeSamlConfiguration(draft, pending, route.transport);
    },
    release: async () => {
      actor.release();
      await route.retire();
    },
  });
}
export { saveCapturedIdentityConfiguration as saveConfiguredNativeSaml } from "./identity-configuration-publication.js";
function retainPopup(original: ReturnType<typeof resumeNativeAuthPopup>) {
  const show = original.showFormConsent;
  const cancel = original.cancel;
  const assertCurrent = () => {
    if (original.showFormConsent !== show || original.cancel !== cancel)
      throw new Error("Original SAML consent window changed");
  };
  return Object.freeze({
    showFormConsent: (request: Parameters<typeof show>[0]) => {
      assertCurrent();
      const result = show.call(original, request);
      assertCurrent();
      return result;
    },
    cancel: () => cancel.call(original),
  });
}
/** Called directly by the deliberate core workflow before its first private read or await. */
export async function beginSavedNativeSaml(
  connectionId: string,
): Promise<void> {
  const original = captureNativeIdentityOwner(connectionId);
  let popup: ReturnType<typeof retainPopup> | null = null;
  let route: ReturnType<typeof captureMetadataRoute> | null = null;
  try {
    const publicDraft = readIdentityConnection(connectionId);
    if (publicDraft && publicDraft.protocol !== "saml")
      throw new Error("Saved SAML configuration is unavailable");
    route = captureMetadataRoute(publicDraft?.samlMetadataUrl ?? null, {
      signal: original.signal,
      assertCurrent: original.assertPending,
    });
    const window = page().open(
      "about:blank",
      "_blank",
      "popup,width=600,height=720",
    );
    if (!window)
      throw new Error("Allow the identity sign-in window and try again");
    popup = retainPopup(resumeNativeAuthPopup(window));
    route.assertCurrent();
    await hydrateIdentityConnections();
    route.assertCurrent();
    const draft = getIdentityConnectionRuntime(connectionId);
    if (!draft || draft.protocol !== "saml")
      throw new Error("Saved native SAML connection changed");
    requireValidIdentityConnection(draft);
    original.bindConfiguration(draft);
    const { signInConfiguredNativeSaml } = await import(
      "./saml/configured-runtime.js"
    );
    route.assertCurrent();
    const capturedRoute = route;
    const owner = Object.freeze({
      ...original,
      assertPending: () => {
        original.assertPending();
        capturedRoute.assertAuthority();
      },
      prepareRuntime: (install: () => void) => {
        capturedRoute.assertAuthority();
        original.prepareRuntime(install);
        capturedRoute.assertAuthority();
      },
      assertSessionCurrent: (issuer: string, audience: string) => {
        original.assertSessionCurrent(issuer, audience);
        capturedRoute.assertAuthority();
      },
    });
    await signInConfiguredNativeSaml(
      connectionId,
      draft,
      owner,
      popup,
      route.retire,
      route.transport,
    );
  } catch (error) {
    original.release();
    popup?.cancel();
    throw error;
  } finally {
    await route?.retire();
  }
}
