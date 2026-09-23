import { afterEach, describe, expect, it } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import {
  brokerAuthorizeUrl,
  scriptTagSrc,
  staticSiteExplicitSnippet,
  staticSiteSnippet,
} from "./site-broker.js";

afterEach(() => configureHost(createTestHost()));

describe("the embeddable sign-in snippet", () => {
  it("emits a declarative snippet and an explicit escape hatch", () => {
    configureHost(
      createTestHost({
        staticAuth: { version: "1.0.2", sri: "sha384-release" },
      }),
    );
    const base = "https://tyler-r-kendrick.github.io/OpenSesame/";
    expect(scriptTagSrc(base)).toBe(
      "https://tyler-r-kendrick.github.io/OpenSesame/static-auth/1.0.2/opensesame-auth.min.js",
    );
    expect(
      brokerAuthorizeUrl({ origin: "http://localhost:5173", state: "x" }, base),
    ).toContain("/broker/authorize");
    const snippet = staticSiteSnippet({
      brokerBase: base,
      siteOrigin: "http://localhost:5173",
    });
    expect(snippet).toContain("opensesame-auth.min.js");
    expect(snippet).toContain('integrity="sha384-release"');
    expect(snippet).toContain('crossorigin="anonymous"');
    expect(snippet).not.toContain("console.log");
    expect(snippet).toContain("pages_passthrough_loopback");

    const explicit = staticSiteExplicitSnippet({
      brokerBase: base,
      siteOrigin: "http://localhost:5173",
    });
    expect(explicit).toContain("OpenSesame.signIn(profile)");
    expect(explicit).toContain('id="opensesame-signin"');
  });

  it("refuses to embed where the host serves no SDK release", () => {
    expect(() => scriptTagSrc("https://example.org/")).toThrow(
      /no static-auth SDK release/,
    );
  });
});
