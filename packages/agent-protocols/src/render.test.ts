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
    expect(md).not.toMatch(/\bsk_live\b|BEGIN PRIVATE KEY|Bearer [A-Za-z0-9\-_]{20,}/u);
    expect(md).toContain("/device");
    expect(md).toContain("/claim");
    expect(md.toLowerCase()).toContain("never embed");
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
