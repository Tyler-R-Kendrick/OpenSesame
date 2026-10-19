/** @vitest-environment node */
import { CONNECT_PLAN_JSON } from "@opensesame/app-core/lib/connect-presets.generated.js";
import { projectNativeAgentcardOrganization } from "@opensesame/app-core/lib/native-api-agentcard.js";
import { expect, it } from "vitest";
import { nativeApiFixture } from "./native-browser-provider-fixtures.mjs";
const plan = CONNECT_PLAN_JSON.map((text) => JSON.parse(text)).find(
  (p) => p.id === "agentcard",
);
it("aligns the compiled platform Bearer endpoint and actual safe organization projection", () => {
  const fixture = nativeApiFixture(plan);
  expect(plan.refused).toBe(false);
  expect(plan.methods.map((m) => m.kind)).toEqual(["api-key"]);
  expect(fixture.preset.auth).toEqual({
    kind: "header",
    header: "Authorization",
    scheme: "Bearer",
    valueTemplate: null,
  });
  expect(fixture.parameters).toEqual({});
  expect(fixture.preset.credentialVariants).toEqual([]);
  expect(fixture.read.url).toBe("https://api.agentcard.sh/api/v2");
  expect(fixture.read.method).toBe("GET");
  expect(fixture.read.headers).toEqual({});
  expect(projectNativeAgentcardOrganization(fixture.reply)).toEqual(
    fixture.read.result,
  );
  expect(projectNativeAgentcardOrganization(fixture.read.reply)).toEqual(
    fixture.read.result,
  );
});
it("keeps synthetic platform replies isolated across fixture owners", () => {
  const a = nativeApiFixture(plan);
  a.reply.organization_id = "other";
  a.read.reply.test_mode = false;
  const b = nativeApiFixture(plan);
  expect(b.reply.organization_id).toBe("owned-organization");
  expect(b.read.reply.test_mode).toBe(true);
});
