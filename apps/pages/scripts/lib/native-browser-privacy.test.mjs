/** @vitest-environment node */
import { CONNECT_PLAN_JSON } from "@opensesame/app-core/lib/connect-presets.generated.js";
import { projectNativePrivacyCards } from "@opensesame/app-core/lib/native-api-privacy.js";
import { expect, it } from "vitest";
import { nativeApiFixture } from "./native-browser-provider-fixtures.mjs";

const privacy = CONNECT_PLAN_JSON.map((text) => JSON.parse(text)).find(
  (plan) => plan.id === "privacy",
);
it.each(["sandbox", "production"])(
  "aligns the actual generated %s api-key-prefixed and resource fixture",
  (environment) => {
    expect(privacy.refused).toBe(false);
    expect(privacy.methods.map((method) => method.kind)).toEqual(["api-key"]);
    const fixture = nativeApiFixture(privacy, environment);
    expect(fixture.parameters).toEqual({ credential_variant: environment });
    expect(fixture.preset.auth).toEqual({
      kind: "header",
      header: "Authorization",
      scheme: "api-key",
      valueTemplate: null,
    });
    expect(fixture.preset.verify).toMatchObject({
      method: "GET",
      url: `https://${environment === "sandbox" ? "sandbox" : "api"}.privacy.com/v1/cards?page=1&page_size=20`,
      headers: {},
    });
    expect(fixture.read.url).toBe(fixture.preset.verify.url);
    expect(fixture.read.headers).toEqual({});
    expect(projectNativePrivacyCards(fixture.reply)).toEqual(
      fixture.read.result,
    );
    expect(projectNativePrivacyCards(fixture.read.reply)).toEqual(
      fixture.read.result,
    );
  },
);
it("does not share mutable inventory between fixture instances or environments", () => {
  const first = nativeApiFixture(privacy, "sandbox");
  first.reply.data.length = 0;
  first.read.reply.data.length = 0;
  expect(nativeApiFixture(privacy, "sandbox").reply.data).toHaveLength(1);
  expect(nativeApiFixture(privacy, "production").read.reply.data).toHaveLength(
    1,
  );
});
it("projects no private card details from the browser authority response", () => {
  const fixture = nativeApiFixture(privacy);
  Object.assign(fixture.reply.data[0], {
    pan: "private-pan",
    cvv: "private-cvv",
    memo: "private-memo",
  });
  expect(projectNativePrivacyCards(fixture.reply)).toEqual(fixture.read.result);
});
