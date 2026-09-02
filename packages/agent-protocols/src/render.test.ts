import { describe, expect, it } from "vitest";
import { renderAgentCard, renderAuthMd } from "./render.js";

const authConfig = {
  serviceName: "OpenSesame",
  protectedResource: "https://api.opensesame.test",
  authorizationServer: "http://127.0.0.1:8788",
  consoleOrigin: "http://127.0.0.1:5173",
  registrationModes: ["anonymous", "pre_registered"],
  tokenAudiences: ["https://api.opensesame.test", "rp-alpha"],
};

describe("renderAuthMd", () => {
  it("matches snapshot and omits secrets", () => {
    const md = renderAuthMd(authConfig);
    expect(md).toMatchSnapshot();
    expect(md).not.toMatch(
      /\bsk_live\b|BEGIN PRIVATE KEY|Bearer [A-Za-z0-9\-_]{20,}/u,
    );
    expect(md).toContain("/agent/identity");
    expect(md).toContain("/oauth2/token");
    expect(md).toContain("/claim");
    expect(md).toContain("not advertised and not enabled");
    expect(md.toLowerCase()).toContain("never embed");
  });

  it("does not advertise disabled ID-JAG or events", () => {
    const md = renderAuthMd({
      ...authConfig,
      capabilities: {
        anonymous: true,
        serviceAuth: true,
        providerAssertion: false,
        events: false,
      },
    });
    expect(md).toContain("not advertised and not enabled");
    expect(md).not.toMatch(/assertion_types_supported/u);
  });
});

describe("renderAgentCard", () => {
  it("matches snapshot without credentials", () => {
    const card = renderAgentCard({
      name: "OpenSesame Agent API",
      url: "http://127.0.0.1:8788",
      capabilities: ["anonymous_register", "claim_poll"],
    });
    expect(card).toMatchSnapshot();
    expect(JSON.stringify(card)).not.toMatch(/secret|password|access_token/iu);
  });
});
