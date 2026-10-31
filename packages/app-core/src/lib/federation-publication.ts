/** Canonical saved-generation publication and one-use handoff from the actual verified exchange. */
import type { CompletedSignIn } from "./federation-contract.js";
import { FederationError } from "./federation-error.js";
import type { FederationExchangeContext } from "./federation-exchange.js";
import {
  type FederationSessionGeneration,
  type UpstreamIdentity,
  advanceFederationSessionGeneration,
  federationSessionGeneration,
  isNativeFederationFormat,
} from "./federation-native-session.js";
import {
  clearFederationSessionJson,
  writeFederationSessionJson,
} from "./federation-session-store.js";
import { rememberLastSignIn } from "./last-sign-in.js";
import { onVaultLock } from "./vault/lock-events.js";

type CompletionOwner = Readonly<{
  generation: FederationSessionGeneration;
  assertCurrent: () => void;
  assertConfiguration: () => void;
}>;
type BrokeredPublication = Readonly<{
  accessToken: string;
  initiating: FederationSessionGeneration;
  published: FederationSessionGeneration;
  assertConfiguration: () => void;
}>;
type SavedPublication = Readonly<{
  generation: FederationSessionGeneration;
  identity: UpstreamIdentity;
}>;
type PublicationSlot = { current: SavedPublication | null };
type ExchangeRequest = Pick<
  FederationExchangeContext,
  | "pending"
  | "body"
  | "origin"
  | "clientId"
  | "upstreams"
  | "assertCurrent"
  | "decodeClaims"
  | "issuerTrusted"
  | "issuerBrokered"
  | "subjectIsPairwise"
>;
let brokeredPublication: BrokeredPublication | null = null;
export function forgetBrokeredPublication(): void {
  brokeredPublication = null;
}
export const federationExchangeSeams = {
  load: (): Promise<typeof import("./federation-exchange.js")> =>
    import("./federation-exchange.js"),
};

function assertGeneration(expected: FederationSessionGeneration): void {
  if (federationSessionGeneration() !== expected)
    throw new FederationError(
      "sign_in_cancelled",
      "That sign-in was ended by a sign-out. Start again.",
    );
}

// The generation also fences an adoption whose one-use receipt was already consumed.
onVaultLock(() => {
  brokeredPublication = null;
  advanceFederationSessionGeneration();
});

/** Saved JWT metadata retains the original API; native protocol evidence cannot be serialized here. */
export function saveSession(
  identity: UpstreamIdentity,
  expectedGeneration?: FederationSessionGeneration,
): FederationSessionGeneration {
  if (isNativeFederationFormat(identity.assertionFormat))
    throw new Error(
      "Native identity evidence must remain in its verified browser session",
    );
  if (expectedGeneration !== undefined) assertGeneration(expectedGeneration);
  const published = advanceFederationSessionGeneration();
  brokeredPublication = null;
  assertGeneration(published);
  writeFederationSessionJson(JSON.stringify(identity));
  assertGeneration(published);
  rememberLastSignIn(identity.upstreamId);
  assertGeneration(published);
  return published;
}

/** This helper invokes the real deferred verifier; a serialized result cannot manufacture a receipt. */
export async function runOwnedFederationExchange(
  request: ExchangeRequest,
  owner: CompletionOwner,
): Promise<CompletedSignIn> {
  const publication: PublicationSlot = { current: null };
  const { exchangeCapturedSignIn } = await federationExchangeSeams.load();
  owner.assertCurrent();
  const context = Object.freeze({
    ...request,
    save(identity: UpstreamIdentity) {
      publication.current = Object.freeze({
        generation: saveSession(identity, owner.generation),
        identity,
      });
    },
  });
  try {
    const result = await exchangeCapturedSignIn(context);
    // Org returns deliberately do not save a durable federation session.
    const published = publication.current;
    if (!published) {
      owner.assertCurrent();
      return result;
    }
    assertGeneration(published.generation);
    owner.assertConfiguration();
    if (result.identity !== published.identity)
      throw new FederationError(
        "invalid_request",
        "The completed identity changed during publication",
      );
    if (result.accessToken)
      brokeredPublication = Object.freeze({
        accessToken: result.accessToken,
        initiating: owner.generation,
        published: published.generation,
        assertConfiguration: owner.assertConfiguration,
      });
    return result;
  } catch (error) {
    // Never erase a newer authentication when retiring this exact failed publication.
    const published = publication.current;
    if (published && federationSessionGeneration() === published.generation) {
      advanceFederationSessionGeneration();
      clearFederationSessionJson();
    }
    throw error;
  }
}

/** Only the exact token and initiating owner from a real completion may cross its own save transition. */
export function consumeBrokeredPublication(
  accessToken: string,
  initiating: FederationSessionGeneration | undefined,
): Readonly<{
  generation: FederationSessionGeneration;
  assertCurrent: () => void;
}> | null {
  const original = brokeredPublication;
  if (
    !original ||
    original.accessToken !== accessToken ||
    original.initiating !== initiating
  )
    return null;
  brokeredPublication = null;
  const assertCurrent = () => {
    assertGeneration(original.published);
    original.assertConfiguration();
  };
  assertCurrent();
  return Object.freeze({ generation: original.published, assertCurrent });
}
