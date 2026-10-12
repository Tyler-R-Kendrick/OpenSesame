/** Public DCR and code exchange at the provider's compiled endpoints. */
import {
  assertPublicConsent,
  assertPublicExchange,
  consentDocument,
  publicAuthorityReply,
} from "./native-public-consent-authority.mjs";

export function answerMcpAuthorization(route, ports) {
  const {
    request,
    url,
    metadata,
    state,
    callback,
    harness,
    clientId,
    access,
    refresh,
    management,
    registrationUrl,
  } = ports;
  if (url.origin + url.pathname === metadata.authorizationEndpoint) {
    state.consent = url;
    const destination = new URL("../connections", callback);
    destination.searchParams.set("native_callback", "1");
    destination.searchParams.set("native_code", "protocol-adobe-code");
    destination.searchParams.set("native_state", url.searchParams.get("state"));
    state.expectedDocuments.add(destination.href);
    assertPublicConsent(url, callback, harness.check);
    harness.check(
      url.searchParams.get("client_id") === clientId,
      "MCP consent uses the client actually issued by DCR",
    );
    harness.check(
      url.searchParams.get("resource") === metadata.resource,
      "MCP consent binds the compiled resource",
    );
    return route.fulfill({
      contentType: "text/html",
      body: consentDocument(url, callback, "protocol-adobe-code"),
    });
  }
  if (url.origin + url.pathname === metadata.registrationEndpoint) {
    const input = request.postDataJSON();
    harness.check(
      input.token_endpoint_auth_method === "none",
      "DCR registers a public client",
    );
    harness.check(
      input.redirect_uris.length === 1 && input.redirect_uris[0] === callback,
      "DCR pins the deployed callback",
    );
    harness.check(!input.client_secret, "DCR sends no confidential secret");
    state.registration = input;
    return publicAuthorityReply(
      route,
      {
        client_id: clientId,
        redirect_uris: [callback],
        token_endpoint_auth_method: "none",
        registration_client_uri: registrationUrl,
        registration_access_token: management,
      },
      201,
    );
  }
  if (url.origin + url.pathname === metadata.tokenEndpoint) {
    const form = new URLSearchParams(request.postData());
    assertPublicExchange(form, state.consent, callback, harness.check);
    harness.check(
      form.get("code") === "protocol-adobe-code",
      "MCP callback exchanges the authority-issued single-use code",
    );
    harness.check(
      form.get("resource") === metadata.resource,
      "MCP token exchange binds the compiled resource",
    );
    return publicAuthorityReply(route, {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3600,
      scope: state.consent.searchParams.get("scope"),
    });
  }
  return null;
}
