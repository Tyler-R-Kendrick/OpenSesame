/** @vitest-environment node */
import { CONNECT_PLAN_JSON } from "@opensesame/app-core/lib/connect-presets.generated.js";
import { projectNativeLithicCards } from "@opensesame/app-core/lib/native-api-lithic.js";
import { expect, it } from "vitest";
import { nativeApiFixture } from "./native-browser-provider-fixtures.mjs";

const lithic = CONNECT_PLAN_JSON.map((text) => JSON.parse(text)).find(
  (plan) => plan.id === "lithic",
);
it.each(["sandbox", "production"])(
  "aligns the actual generated %s raw-key and resource fixture",
  (environment) => {
    expect(lithic.refused).toBe(false);
    expect(lithic.methods.map((method) => method.kind)).toEqual(["api-key"]);
    const fixture = nativeApiFixture(lithic, environment);
    expect(fixture.parameters).toEqual({ credential_variant: environment });
    expect(fixture.preset.auth).toEqual({
      kind: "header",
      header: "Authorization",
      scheme: null,
      valueTemplate: null,
    });
    expect(fixture.preset.verify).toMatchObject({
      method: "GET",
      url: `https://${environment === "sandbox" ? "sandbox" : "api"}.lithic.com/v1/cards?page_size=20`,
      headers: { "api-version": "2026-07-01" },
    });
    expect(fixture.read.url).toBe(fixture.preset.verify.url);
    expect(fixture.read.headers).toEqual({ "api-version": "2026-07-01" });
    expect(projectNativeLithicCards(fixture.reply)).toEqual(
      fixture.read.result,
    );
    expect(projectNativeLithicCards(fixture.read.reply)).toEqual(
      fixture.read.result,
    );
  },
);
it("does not share mutable inventory between fixture instances or environments", () => {
  const first = nativeApiFixture(lithic, "sandbox");
  first.reply.data.length = 0;
  first.read.reply.data.length = 0;
  expect(nativeApiFixture(lithic, "sandbox").reply.data).toHaveLength(1);
  expect(nativeApiFixture(lithic, "production").read.reply.data).toHaveLength(
    1,
  );
});
it("projects no private card details from the browser authority response", () => {
  const fixture = nativeApiFixture(lithic);
  Object.assign(fixture.reply.data[0], {
    pan: "private-pan",
    cvv: "private-cvv",
    memo: "private-memo",
  });
  expect(projectNativeLithicCards(fixture.reply)).toEqual(fixture.read.result);
});
