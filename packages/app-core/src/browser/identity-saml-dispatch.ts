/** Original SAML workflow authority is retained before cold ledger or protocol imports. */
import { currentAuthGeneration } from "../lib/ambient-auth/generation.js";
import type { Connection } from "../lib/connections.js";
import { deviceConnection } from "../lib/device-connectors.js";
import { resolveIdentityBase } from "../lib/device-identity.js";
import { federationSessionGeneration } from "../lib/federation-native-session.js";
import { clearSession, loadSession } from "../lib/federation.js";
import type { IdentityConnectionDraft } from "../lib/identity-connections-schema.js";
import {
  type IdentityConnectionPublication,
  assertIdentityConnectionPublication,
  compensateIdentityConnectionPublication,
  getIdentityConnectionRuntime,
  hydrateIdentityConnections,
  identityConnectionRevision,
  readIdentityConnection,
  writeIdentityConnection,
} from "../lib/identity-connections-store.js";
import {
  assertIdentityTrustAvailable,
  projectIdentityTrust,
} from "../lib/identity-connections-trust.js";
import { requireValidIdentityConnection } from "../lib/identity-connections-validation.js";
import { captureNativeIdentityOwner } from "../lib/identity-native-owner.js";
import { currentSession } from "../lib/identity.js";
import { captureNativeProviderAuthority } from "../lib/native-connector-transport.js";
import {
  type OperatorIdp,
  loadSettings,
  saveSettingsDurable,
  signInMethods,
} from "../lib/settings.js";
import { vaultStore } from "../lib/vault/store.js";
import { page } from "../ports.js";
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
  const original = vaultStore.getSnapshot();
  const header = JSON.stringify(original.header);
  const auth = currentAuthGeneration();
  const session = currentSession();
  const realm = resolveIdentityBase();
  let generation = federationSessionGeneration();
  const revision = existingId ? identityConnectionRevision(existingId) : null;
  const stop = new AbortController();
  const owner = Object.freeze({
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]),
    assertCurrent: () => {
      stop.signal.throwIfAborted();
      const now = vaultStore.getSnapshot();
      if (
        now.tomb !== original.tomb ||
        now.status !== original.status ||
        now.guest !== original.guest ||
        now.awaitingSecondStep !== original.awaitingSecondStep ||
        JSON.stringify(now.header) !== header ||
        currentAuthGeneration() !== auth ||
        currentSession() !== session ||
        resolveIdentityBase() !== realm
      )
        throw new Error("Original SAML configuration authority changed");
    },
  });
  const actor = owner.assertCurrent;
  const pending = Object.freeze({
    signal: owner.signal,
    assertCurrent: () => {
      actor();
      if (
        federationSessionGeneration() !== generation ||
        (existingId && identityConnectionRevision(existingId) !== revision)
      )
        throw new Error("Original SAML configuration authority changed");
    },
  });
  const route = captureMetadataRoute(metadataUrl, pending);
  const assertActor = () => {
    actor();
    route.assertAuthority();
    if (federationSessionGeneration() !== generation)
      throw new Error("Original SAML configuration authority changed");
  };
  return Object.freeze({
    assertCurrent: route.assertCurrent,
    assertActor,
    clearOwnSession: () => {
      assertActor();
      clearSession();
      actor();
      route.assertAuthority();
      if (loadSession() !== null)
        throw new Error(
          "Original identity session changed during configuration",
        );
      generation = federationSessionGeneration();
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
      stop.abort();
      await route.retire();
    },
  });
}
function projection(id: string): OperatorIdp | undefined {
  return signInMethods().providers.find(
    (provider) => provider.connectionId === id,
  );
}
function assertProjection(id: string, expected: OperatorIdp | undefined): void {
  if (JSON.stringify(projection(id)) !== JSON.stringify(expected))
    throw new Error("Original public identity trust changed");
}
async function restoreSamlTrust(
  id: string,
  expected: OperatorIdp,
  previous: OperatorIdp | undefined,
  previousIndex: number,
  publication: IdentityConnectionPublication,
): Promise<void> {
  if (JSON.stringify(projection(id)) !== JSON.stringify(expected)) return;
  const current = loadSettings();
  const methods = signInMethods(current);
  const providers = methods.providers.filter(
    (provider) => provider.connectionId !== id,
  );
  if (previous)
    providers.splice(Math.min(previousIndex, providers.length), 0, previous);
  await saveSettingsDurable(
    { ...current, signIn: { ...methods, providers } },
    () => {
      assertIdentityConnectionPublication(id, publication);
      assertProjection(id, expected);
    },
  );
}
type SamlPublicationState = { current: IdentityConnectionPublication | null };
/** A successful provider check cannot publish a save under a retired actor. */
export async function saveConfiguredNativeSaml(
  draft: IdentityConnectionDraft,
  existingId: string | undefined,
  owner: ReturnType<typeof captureSamlConfiguration>,
): Promise<Connection> {
  owner.assertCurrent();
  const previous = existingId ? getIdentityConnectionRuntime(existingId) : null;
  const previousProjection = existingId ? projection(existingId) : undefined;
  const previousIndex = existingId
    ? signInMethods().providers.findIndex(
        (provider) => provider.connectionId === existingId,
      )
    : 0;
  assertIdentityTrustAvailable(draft, existingId ?? "", null);
  await owner.check(draft);
  owner.assertCurrent();
  const retiringSession = loadSession();
  owner.assertCurrent();
  if (existingId && retiringSession?.upstreamId === `identity:${existingId}`)
    owner.clearOwnSession();
  owner.assertCurrent();
  const publication: SamlPublicationState = {
    current: null,
  };
  let id = existingId;
  let expected: OperatorIdp | null = null;
  try {
    const connection = await writeIdentityConnection(
      draft,
      existingId,
      owner.assertCurrent,
      (prepared) => {
        publication.current = prepared;
      },
    );
    id = connection.connectionId;
    const receipt = publication.current;
    if (!receipt)
      throw new Error("Original identity publication was not prepared");
    const selected = id;
    const assertOwned = () => {
      owner.assertActor();
      assertIdentityConnectionPublication(selected, receipt);
    };
    assertOwned();
    assertProjection(selected, previousProjection);
    expected = {
      protocol: "saml",
      providerId: draft.providerId,
      issuer: draft.samlEntityId,
      clientId: draft.clientId,
      connectionId: selected,
      label: draft.name,
    };
    await projectIdentityTrust(draft, selected, null, () => {
      assertOwned();
      assertProjection(selected, previousProjection);
    });
    assertOwned();
    assertProjection(selected, expected);
    const view = deviceConnection(selected) ?? connection;
    assertOwned();
    assertProjection(selected, expected);
    return view;
  } catch (error) {
    const receipt = publication.current;
    if (receipt)
      await compensateIdentityConnectionPublication(
        id,
        receipt,
        previous,
        async (selected) => {
          if (expected)
            await restoreSamlTrust(
              selected,
              expected,
              previousProjection,
              previousIndex,
              receipt,
            );
        },
      );
    throw error;
  }
}
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
