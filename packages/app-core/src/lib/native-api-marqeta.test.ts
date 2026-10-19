import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderPlanJson } from "../../scripts/emit-connect-presets.mjs";
import { connectPlan } from "./connect-plan.js";
import { nativeApiVerificationRequest } from "./native-api-auth.js";
import { configureNativeApiConnector } from "./native-api-connectors.js";
import { projectNativeMarqetaUsers } from "./native-api-marqeta.js";
import {
  type NativeApiOperationDefinition,
  executeNativeApiRequest,
} from "./native-api-operations.js";
import { nativeApiResourceActions } from "./native-api-resources.js";
import {
  type NativeApiTarget,
  nativeApiCredentials,
  nativeApiFingerprint,
  nativeApiTarget,
} from "./native-api-target.js";
import {
  installNativeApiTests,
  nativeAnswers,
} from "./native-api.test-support.js";

installNativeApiTests();

const presets = JSON.parse(
  readFileSync(
    new URL(
      "../../../../spec/connectors/connect-presets.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const preset = presets.api_key.find(
  (row: { service: string }) => row.service === "marqeta",
);
const services = {
  services: JSON.parse(
    readFileSync(
      new URL(
        "../../../../spec/connectors/connect-services.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).services.filter((row: { service: string }) => row.service === "marqeta"),
};
function plan(row: typeof preset) {
  return renderPlanJson(
    services,
    { oauth: [], api_key: row ? [row] : [] },
    { providers: [] },
  )
    .map((text) => JSON.parse(text))
    .find((entry) => entry.id === "marqeta");
}
const application = "owned-application";
const admin = "owned-admin:separate~secret";
const user = { token: "owned-user", active: true };
const users = {
  count: 1,
  start_index: 0,
  end_index: 0,
  is_more: false,
  data: [user],
};
function parameters(variant: string): NativeApiTarget["parameters"] {
  return variant === "program"
    ? { credential_variant: variant, program_host: "program-api.example.test" }
    : { credential_variant: variant };
}
function editRequest(row: typeof preset, change: string) {
  const verify = row.credential_variants[1].verify;
  if (change === "write") verify.method = "POST";
  if (change === "host")
    verify.url = verify.url.replace("{program_host}", "other.test");
  if (change === "path") verify.url = verify.url.replace("/users?", "/cards?");
  if (change === "count")
    verify.url = verify.url.replace("count=10", "count=100");
  if (change === "page")
    verify.url = verify.url.replace("start_index=0", "start_index=1");
  if (change === "fields")
    verify.url = verify.url.replace("token%2Cactive", "token%2Cemail");
  if (change === "body") verify.body = "{}";
  if (change === "header") verify.headers = { "X-Marqeta-Account": "other" };
  if (change === "auth-override") verify.header = "X-Key";
}
function editCredentials(row: typeof preset, change: string) {
  if (change === "username") row.basic.username = "{admin_access_token}";
  if (change === "password") row.basic.password = "";
  if (change === "optional") row.additional_credentials[0].required = false;
  if (change === "public-secret") row.additional_credentials[0].secret = false;
  if (change === "extra-secret")
    row.additional_credentials.push({
      ...row.additional_credentials[0],
      name: "other",
    });
  if (change === "bearer") {
    row.basic = null;
    row.scheme = "Bearer";
  }
}
function editEnvironment(row: typeof preset, change: string) {
  if (change === "origin") row.service_urls.push("https://other.test");
  if (change === "missing-variant") row.credential_variants.pop();
  if (change === "extra-variant")
    row.credential_variants.push(row.credential_variants[0]);
  if (change === "duplicate-variant") row.credential_variants[1].id = "sandbox";
  if (change === "default-host") row.verify = row.credential_variants[1].verify;
  if (change === "private-host")
    row.credential_variants[1].template_params[0].secret = true;
  if (change === "optional-host")
    row.credential_variants[1].template_params[0].required = false;
  if (change === "other-host-field")
    row.credential_variants[1].template_params[0].name = "other";
}
describe("Marqeta native readonly contract", () => {
  it.each(["sandbox", "program"])(
    "reads only the selected %s origin and refuses an unrelated explicit origin before HTTP",
    async (variant) => {
      const provider = nativeAnswers(
        { body: users },
        { body: users },
        { body: users },
      );
      const selected = parameters(variant);
      const view = await configureNativeApiConnector(
        {
          providerId: "marqeta",
          displayName: "Owned program",
          parameters: selected,
          credentials: { api_key: application, admin_access_token: admin },
        },
        provider.transport,
      );
      const definition = {
        providerId: "marqeta",
        operationId: "provider.users.read",
        method: "GET",
        path: "/v3/users",
        query: { count: 10, start_index: 0, fields: "token,active" },
      } satisfies NativeApiOperationDefinition;
      expect(
        await executeNativeApiRequest(
          view.connectionId,
          definition,
          {},
          projectNativeMarqetaUsers,
          provider.transport,
        ),
      ).toMatchObject({ items: [{ id: "owned-user" }] });
      const origin =
        variant === "sandbox"
          ? "https://sandbox-api.marqeta.com"
          : "https://program-api.example.test";
      expect(
        await executeNativeApiRequest(
          view.connectionId,
          { ...definition, origin },
          {},
          projectNativeMarqetaUsers,
          provider.transport,
        ),
      ).toMatchObject({ items: [{ id: "owned-user" }] });
      expect(provider.fetch).toHaveBeenCalledTimes(3);
      await expect(
        executeNativeApiRequest(
          view.connectionId,
          { ...definition, origin: "https://unrelated.example.test" },
          {},
          projectNativeMarqetaUsers,
          provider.transport,
        ),
      ).rejects.toThrow();
      expect(provider.fetch).toHaveBeenCalledTimes(3);
    },
  );
  it("requires both private Basic slots and never treats the admin token as public configuration", () => {
    const target = nativeApiTarget("marqeta", {});
    expect(() =>
      nativeApiCredentials(target, { api_key: application }),
    ).toThrow("required provider credentials");
    expect(() =>
      nativeApiCredentials(target, { admin_access_token: admin }),
    ).toThrow("required provider credentials");
    expect(() =>
      nativeApiTarget("marqeta", { admin_access_token: admin }),
    ).toThrow("public configuration");
  });
  it("keeps all existing payment and Datadog actions singular", () => {
    expect(nativeApiResourceActions("datadog", "api-key")).toEqual([
      { id: "provider.monitors.read", label: "List monitors" },
    ]);
    for (const provider of ["marqeta", "lithic", "privacy"])
      expect(nativeApiResourceActions(provider, "api-key")).toEqual([
        {
          id:
            provider === "marqeta"
              ? "provider.users.read"
              : "provider.cards.read",
          label: provider === "marqeta" ? "List users" : "List cards",
        },
      ]);
  });
  it.each(["sandbox", "program"])(
    "uses exact Basic pair and filtered first page at %s",
    async (variant) => {
      expect(connectPlan("marqeta")?.refused).toBe(false);
      expect(
        plan(preset).methods.map((method: { kind: string }) => method.kind),
      ).toEqual(["api-key"]);
      const target = nativeApiTarget("marqeta", parameters(variant));
      const request = nativeApiVerificationRequest(target, {
        api_key: application,
        admin_access_token: admin,
      });
      expect(String(request.url)).toBe(
        `https://${variant === "sandbox" ? "sandbox-api.marqeta.com" : "program-api.example.test"}/v3/users?count=10&start_index=0&fields=token%2Cactive`,
      );
      expect(request.method).toBe("GET");
      expect(request.body).toBeUndefined();
      expect([...request.headers]).toEqual([
        ["authorization", `Basic ${btoa(`${application}:${admin}`)}`],
      ]);
      const other = nativeApiTarget(
        "marqeta",
        parameters(variant === "sandbox" ? "program" : "sandbox"),
      );
      expect(await nativeApiFingerprint(target)).not.toBe(
        await nativeApiFingerprint(other),
      );
    },
  );
  it.each([
    "write",
    "host",
    "path",
    "count",
    "page",
    "fields",
    "body",
    "header",
    "auth-override",
    "username",
    "password",
    "optional",
    "public-secret",
    "extra-secret",
    "bearer",
    "origin",
    "missing-variant",
    "extra-variant",
    "duplicate-variant",
    "default-host",
    "private-host",
    "optional-host",
    "other-host-field",
  ])("rejects changed authority: %s", (change) => {
    const row = structuredClone(preset);
    editRequest(row, change);
    editCredentials(row, change);
    editEnvironment(row, change);
    expect(plan(row)).toMatchObject({ refused: true, methods: [] });
  });
  it("does not invent an admission when the unlisted Marqeta preset is missing", () => {
    expect(plan(null)).toBeUndefined();
  });
  it.each([
    "https://other.test",
    "user@other.test",
    "other.test/path",
    "other.test?key",
    "other.test#hash",
    "other.test:443",
  ])(
    "refuses URL syntax in the dashboard hostname before dispatch: %s",
    (host) => {
      const target = nativeApiTarget("marqeta", {
        credential_variant: "program",
        program_host: host,
      });
      expect(() =>
        nativeApiVerificationRequest(target, {
          api_key: application,
          admin_access_token: admin,
        }),
      ).toThrow();
    },
  );
  it("requires the program host and distinguishes each exact configured origin", async () => {
    expect(() =>
      nativeApiTarget("marqeta", { credential_variant: "program" }),
    ).toThrow("Program API host");
    const a = nativeApiTarget("marqeta", parameters("program"));
    const b = nativeApiTarget("marqeta", {
      ...parameters("program"),
      program_host: "other-program.example.test",
    });
    expect(await nativeApiFingerprint(a)).not.toBe(
      await nativeApiFingerprint(b),
    );
    expect(nativeApiTarget("marqeta", {}).parameters).toEqual({
      credential_variant: "sandbox",
    });
  });
  it("accepts documented conditional empty pages without claiming account identity", () => {
    for (const empty of [
      {},
      { data: [] },
      { data: [], count: 0, start_index: 0, end_index: -1, is_more: false },
      { data: [], count: 0, end_index: 0 },
    ])
      expect(projectNativeMarqetaUsers(empty)).toEqual({
        label: "Showing 0 users from first page",
        items: [],
      });
  });
  it("preserves only bounded opaque IDs and known active state, without personal or funding data", () => {
    expect(
      projectNativeMarqetaUsers({
        ...users,
        data: [
          {
            ...user,
            first_name: "private-name",
            address1: "private-address",
            birth_date: "private-birth-date",
            identifications: [{ value: "private-id" }],
            balances: "private-balances",
            password: "private-password",
          },
        ],
      }),
    ).toEqual({
      label: "Showing 1 users from first page",
      items: [{ id: "owned-user", label: "owned-user — active" }],
    });
    expect(
      projectNativeMarqetaUsers({
        ...users,
        data: [{ token: "inactive-user", active: false }],
      }),
    ).toMatchObject({ items: [{ label: "inactive-user — inactive" }] });
    expect(
      projectNativeMarqetaUsers({ ...users, data: [{ token: "opaque-user" }] }),
    ).toMatchObject({
      items: [{ label: "opaque-user — status not returned" }],
    });
    expect(
      projectNativeMarqetaUsers({
        ...users,
        count: 2,
        end_index: 1,
        is_more: true,
        data: [{ token: "User" }, { token: "user" }],
      }),
    ).toMatchObject({
      label: "Showing 2 users from first page; more available",
      items: [{ id: "User" }, { id: "user" }],
    });
  });
  it.each([
    null,
    [],
    { unknown: true },
    { error: "private-key" },
    { error_message: "private-key" },
    { count: 0 },
    { is_more: false },
    { data: [], count: 1 },
    { data: [], is_more: true },
    { data: [], end_index: 1 },
    { ...users, count: "1" },
    { ...users, count: 0 },
    { ...users, start_index: 1 },
    { ...users, end_index: 1 },
    { ...users, is_more: "false" },
    { ...users, count: 2, end_index: 1, data: [user, user] },
    { ...users, data: [{ token: "" }] },
    { ...users, data: [{ token: " " }] },
    { ...users, data: [{ token: "line\nbreak" }] },
    { ...users, data: [{ token: "x".repeat(37) }] },
    { ...users, data: [{ ...user, active: "true" }] },
    {
      ...users,
      count: 11,
      end_index: 10,
      data: Array.from({ length: 11 }, (_, i) => ({ token: `user${i}` })),
    },
    { ...users, error: "private-key" },
  ])(
    "refuses unknown-only, contradictory, malformed or excessive responses %#",
    (invalid) => {
      expect(() => projectNativeMarqetaUsers(invalid)).toThrow(
        "Provider did not return the expected response",
      );
    },
  );
});
