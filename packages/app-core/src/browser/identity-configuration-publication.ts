/** Original local configuration actor and guarded owned publication, shared by native identity protocols. */
import { currentAuthGeneration } from "../lib/auth-generation.js";
import type { Connection } from "../lib/connections.js";
import { deviceConnection } from "../lib/device-connectors.js";
import { resolveIdentityBase } from "../lib/device-identity.js";
import { federationSessionGeneration } from "../lib/federation-native-session.js";
import { retireOwnedFederationSession } from "../lib/federation-retirement.js";
import { loadSession } from "../lib/federation.js";
import type {
  IdentityConnectionDraft,
  IdentityConnectionTest,
} from "../lib/identity-connections-schema.js";
import {
  type IdentityConnectionPublication,
  assertIdentityConnectionPublication,
  compensateIdentityConnectionPublication,
  getIdentityConnectionRuntime,
  identityConnectionRevision,
  writeIdentityConnection,
} from "../lib/identity-connections-store.js";
import {
  assertIdentityTrustAvailable,
  identityTrustProjection,
  projectIdentityTrust,
} from "../lib/identity-connections-trust.js";
import { currentSession } from "../lib/identity.js";
import {
  type OperatorIdp,
  loadSettings,
  saveSettingsDurable,
  signInMethods,
} from "../lib/settings.js";
import { vaultStore } from "../lib/vault/store.js";
export type IdentityConfigurationPublicationOwner = Readonly<{
  assertCurrent: () => void;
  assertActor: () => void;
  clearOwnSession: () => void;
  check: (draft: IdentityConnectionDraft) => Promise<IdentityConnectionTest>;
}>;
export function captureIdentityConfigurationActor(
  existingId?: string,
  phase: "metadata" | "enrollment" = "metadata",
) {
  const original = vaultStore.getSnapshot();
  const header = JSON.stringify(original.header);
  const auth = currentAuthGeneration();
  const session = currentSession();
  const realm = resolveIdentityBase();
  let generation = federationSessionGeneration();
  const revision = existingId ? identityConnectionRevision(existingId) : null;
  const stop = new AbortController();
  const signal = AbortSignal.any([
    stop.signal,
    AbortSignal.timeout(phase === "metadata" ? 15000 : 600000),
  ]);
  const assertBase = () => {
    signal.throwIfAborted();
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
      throw new Error("Original identity configuration authority changed");
  };
  const assertActor = () => {
    assertBase();
    if (federationSessionGeneration() !== generation)
      throw new Error("Original identity configuration authority changed");
  };
  const assertCurrent = () => {
    assertActor();
    if (existingId && identityConnectionRevision(existingId) !== revision)
      throw new Error("Original identity configuration authority changed");
  };
  return Object.freeze({
    signal,
    assertCurrent,
    assertActor,
    clearOwnSession: (assertAuthority?: () => void) => {
      assertActor();
      const retired = retireOwnedFederationSession(generation, () => {
        assertBase();
        assertAuthority?.();
        assertBase();
      });
      if (loadSession() !== null || federationSessionGeneration() !== retired)
        throw new Error(
          "Original identity session changed during configuration",
        );
      generation = retired;
      assertActor();
    },
    release: () => stop.abort(),
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
type IdentityPublicationState = {
  current: IdentityConnectionPublication | null;
};
/** A successful provider check cannot publish a save under a retired actor. */
export async function saveCapturedIdentityConfiguration(
  draft: IdentityConnectionDraft,
  existingId: string | undefined,
  owner: IdentityConfigurationPublicationOwner,
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
  const publication: IdentityPublicationState = {
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
    expected = identityTrustProjection(draft, selected);
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
