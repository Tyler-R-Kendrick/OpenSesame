/**
 * A single-page relying party for a Pages Self-Issued OP (ADR 0161): no
 * server of its own, so it verifies the token in the browser.
 *
 * What that proves, and what it does not. The page learns, by a verified
 * signature, that whoever holds the key behind `subject` answered *this*
 * login at *this* redirect_uri for *this* client. It has no back end to trust
 * that to, so the "session" is the page's own memory and ends with the tab.
 * An app with a server wants `app.ts` beside this file instead, where the
 * server holds the state and starts a real session.
 *
 * The one thing a browser must add: the redirect is a full page navigation, so
 * the login's state and nonce live in `sessionStorage`, not in a variable.
 */
import {
  type LoginStorage,
  type MetadataFetch,
  type SiopLoginResult,
  SiopRpError,
  StorageLoginStore,
  createSiopRelyingParty,
  fetchSiopMetadata,
  isSiopV2Error,
  pagesOriginOf,
  pagesSiopIssuer,
} from "@opensesame/siop-v2";

export type SpaConfig = {
  /** The Pages deployment: `https://<owner>.github.io/<repo>`. */
  pagesBase: string;
  /** The application id the person registered in their vault. */
  clientId: string;
};

/** The parts of `location` the flow reads. */
export type SpaPage = {
  origin: string;
  pathname: string;
  search: string;
  hash: string;
};

export type SpaDeps = {
  storage: LoginStorage;
  fetch: MetadataFetch;
  page: SpaPage;
  /** Leave for the OP: `location.assign`. */
  navigate(url: string): void;
  /** Replace the address bar's URL: `history.replaceState`. */
  scrub(url: string): void;
  now?: (() => number) | undefined;
};

export type SpaOutcome =
  | { kind: "none" }
  | { kind: "signed-in"; result: SiopLoginResult }
  | { kind: "refused"; code: string };

function issuerOf(config: SpaConfig): string {
  return pagesSiopIssuer(pagesOriginOf(config.pagesBase));
}

function relyingParty(
  config: SpaConfig,
  deps: SpaDeps,
  authorizationEndpoint?: string,
) {
  return createSiopRelyingParty({
    issuer: issuerOf(config),
    authorizationEndpoint,
    clientId: config.clientId,
    // The page is its own callback: the redirect_uri is the address without
    // its query or fragment, and it must be the one the person registered.
    redirectUri: `${deps.page.origin}${deps.page.pathname}`,
    store: new StorageLoginStore(deps.storage),
    now: deps.now,
  });
}

/**
 * Read the deployment's metadata (pinned to the issuer this app was configured
 * for), then send the person to the endpoint it names. Throws, and does not
 * navigate, when the document is missing or is not for that issuer.
 */
export async function beginSignIn(
  config: SpaConfig,
  deps: SpaDeps,
): Promise<void> {
  const accepted = await fetchSiopMetadata({
    fetch: deps.fetch,
    expectedIssuer: issuerOf(config),
  });
  const { authorizationUrl } = await relyingParty(
    config,
    deps,
    accepted.authorizationEndpoint,
  ).startLogin();
  deps.navigate(authorizationUrl);
}

function refusalCode(failure: Error): string {
  if (failure instanceof SiopRpError) return failure.code;
  if (isSiopV2Error(failure)) return failure.code;
  return "unavailable";
}

/**
 * Finish a login when the address carries a response; `none` when it does not.
 * The fragment is removed from the address bar first: until it is verified it
 * is a credential.
 */
export async function finishSignIn(
  config: SpaConfig,
  deps: SpaDeps,
): Promise<SpaOutcome> {
  const response = deps.page.hash;
  if (response.length <= 1) return { kind: "none" };
  deps.scrub(`${deps.page.pathname}${deps.page.search}`);
  try {
    const result = await relyingParty(config, deps).completeLogin({
      response,
      receivedRedirectUri: `${deps.page.origin}${deps.page.pathname}`,
    });
    return { kind: "signed-in", result };
  } catch (failure) {
    return {
      kind: "refused",
      code: refusalCode(failure instanceof Error ? failure : new Error()),
    };
  }
}
