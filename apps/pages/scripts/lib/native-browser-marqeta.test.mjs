/** @vitest-environment node */
import { CONNECT_PLAN_JSON } from "@opensesame/app-core/lib/connect-presets.generated.js";
import { projectNativeMarqetaUsers } from "@opensesame/app-core/lib/native-api-marqeta.js";
import { expect, it } from "vitest";
import { nativeApiFixture } from "./native-browser-provider-fixtures.mjs";
const marqeta = CONNECT_PLAN_JSON.map((text) => JSON.parse(text)).find(
  (plan) => plan.id === "marqeta",
);
it.each(["sandbox", "program"])(
  "aligns the actual generated %s Basic pair, host and filtered inventory",
  (environment) => {
    expect(marqeta.refused).toBe(false);
    expect(marqeta.methods.map((method) => method.kind)).toEqual(["api-key"]);
    const fixture = nativeApiFixture(marqeta, environment);
    expect(fixture.parameters.credential_variant).toBe(environment);
    if (environment === "program")
      expect(fixture.parameters.program_host).toBe("program-api.example.test");
    expect(fixture.preset.auth).toEqual({
      kind: "basic",
      username: "{key}",
      password: "{admin_access_token}",
    });
    expect(fixture.preset.additionalCredentials).toMatchObject([
      { name: "admin_access_token", required: true, secret: true },
    ]);
    expect(fixture.credentials.admin_access_token).toBeTruthy();
    expect(fixture.read.url).toBe(
      `https://${environment === "sandbox" ? "sandbox-api.marqeta.com" : "program-api.example.test"}/v3/users?count=10&start_index=0&fields=token%2Cactive`,
    );
    expect(fixture.preset.verify).toMatchObject({ method: "GET", headers: {} });
    expect(fixture.read.headers).toEqual({});
    expect(projectNativeMarqetaUsers(fixture.reply)).toEqual(
      fixture.read.result,
    );
    expect(projectNativeMarqetaUsers(fixture.read.reply)).toEqual(
      fixture.read.result,
    );
  },
);
it("keeps documented responses independent between fixture instances and strips personal fields", () => {
  const first = nativeApiFixture(marqeta);
  Object.assign(first.reply.data[0], {
    first_name: "private-name",
    password: "private-password",
    identifications: [{ value: "private-identity" }],
  });
  expect(projectNativeMarqetaUsers(first.reply)).toEqual(first.read.result);
  first.reply.data.length = 0;
  first.read.reply.data.length = 0;
  expect(nativeApiFixture(marqeta).reply.data).toHaveLength(1);
  expect(nativeApiFixture(marqeta, "program").read.reply.data).toHaveLength(1);
});
