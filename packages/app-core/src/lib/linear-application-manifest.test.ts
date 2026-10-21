import { describe, expect, it } from "vitest";
import { linearApplicationManifestUrl } from "./linear-application-manifest.js";

describe("Linear OAuth application manifest URL", () => {
  it("prefills only the browser callback, public app metadata and authorization-code grant", () => {
    const url = new URL(
      linearApplicationManifestUrl({
        redirectUri: "https://app.example/auth/linear.html",
        appUrl: "https://app.example/",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://linear.app/settings/api/applications/new",
    );
    expect(url.searchParams.get("distribution")).toBe("private");
    expect(url.searchParams.get("developer.name")).toBe("OpenSesame");
    expect(url.searchParams.get("oauth.client_name")).toBe("OpenSesame");
    expect(url.searchParams.get("oauth.client_uri")).toBe(
      "https://app.example/",
    );
    expect(url.searchParams.getAll("oauth.redirect_uris")).toEqual([
      "https://app.example/auth/linear.html",
    ]);
    expect(url.searchParams.getAll("oauth.grant_types")).toEqual([
      "authorization_code",
    ]);
    expect(url.searchParams.has("webhook.url")).toBe(false);
  });
});
