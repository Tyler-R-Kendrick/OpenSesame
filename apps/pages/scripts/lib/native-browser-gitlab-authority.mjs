/** Official GitLab public PKCE tuple; synthetic account used only for protocol testing. */
import {
  assertPublicConsent,
  assertPublicExchange,
  consentDocument,
  publicAuthorityReply,
} from "./native-public-consent-authority.mjs";

export async function routeNativeGitlabAuthority(context, harness, callback) {
  const state = {
    consent: null,
    calls: [],
    expectedDocuments: new Set(),
    expectedResponses: new Map(),
  };
  const access = "protocol-only-gitlab-access";
  const refresh = "protocol-only-gitlab-refresh";
  const admitted = new Set([
    "/oauth/authorize",
    "/oauth/token",
    "/oauth/revoke",
    "/api/v4/user",
  ]);
  await context.route("https://gitlab.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!admitted.has(url.pathname)) return route.fallback();
    if (request.method() === "OPTIONS")
      return publicAuthorityReply(route, null, 204);
    const headers = await request.allHeaders();
    harness.check(!headers.cookie, "GitLab protocol excludes ambient cookies");
    state.calls.push({ path: url.pathname, method: request.method() });
    if (url.pathname === "/oauth/authorize") {
      state.consent = url;
      assertPublicConsent(url, callback, harness.check);
      harness.check(
        url.searchParams.get("scope").split(" ").includes("read_user"),
        "GitLab consent requests actual account-verification permission",
      );
      const destination = new URL("../connections", callback);
      destination.searchParams.set("native_callback", "1");
      destination.searchParams.set("native_code", "protocol-gitlab-code");
      destination.searchParams.set(
        "native_state",
        url.searchParams.get("state"),
      );
      state.expectedDocuments.add(destination.href);
      return route.fulfill({
        contentType: "text/html",
        body: consentDocument(url, callback, "protocol-gitlab-code"),
      });
    }
    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(request.postData());
      assertPublicExchange(form, state.consent, callback, harness.check);
      harness.check(
        form.get("code") === "protocol-gitlab-code",
        "GitLab callback exchanges the authority-issued single-use code",
      );
      harness.check(
        !headers.authorization,
        "GitLab public token exchange has no client authorization secret",
      );
      return publicAuthorityReply(route, {
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 3600,
        scope: state.consent.searchParams.get("scope"),
      });
    }
    if (url.pathname === "/oauth/revoke") {
      harness.check(
        [access, refresh].includes(
          new URLSearchParams(request.postData()).get("token"),
        ),
        "GitLab disconnect revokes actually issued credentials",
      );
      return publicAuthorityReply(route, null);
    }
    harness.check(
      headers.authorization === `Bearer ${access}`,
      "GitLab account query uses the PIN-sealed provider grant",
    );
    return publicAuthorityReply(route, {
      id: 7,
      name: "Disclosed GitLab protocol account",
      username: "protocol-account",
    });
  });
  return { state, secrets: [access, refresh] };
}
