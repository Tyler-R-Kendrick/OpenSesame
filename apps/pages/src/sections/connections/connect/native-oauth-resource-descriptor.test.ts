import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { nativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import { GOOGLE_ACCOUNT_POLICY } from "@opensesame/app-core/lib/native-google-account-policy.generated.js";
import { normalizeGoogleDriveAccountScopes } from "@opensesame/app-core/lib/native-google-drive-account.js";
import { configuredNativeOAuthPreset } from "@opensesame/app-core/lib/native-oauth-resource-preset.js";
import { expect, it } from "vitest";
import { nativeOAuthClientConfigured } from "../../../modules/connectors.external/native-oauth-resource-runtime.js";
import { nativeBrowserOAuthDescriptor } from "./native-browser-oauth-descriptor.js";
import {
  nativeInitialValues,
  nativeMethodForEdit,
} from "./native-connector-edit-values.js";
import {
  nativeFieldValues,
  nativeNextValues,
  nativeScopeDefaults,
  nativeVisibleFields,
} from "./native-connector-ui-values.js";
import { nativeUiView } from "./native-connector-ui.test-support.js";
import {
  nativeOAuthResourceDescriptor,
  nativePublicApplicationDescriptor,
} from "./native-oauth-resource-descriptor.js";
import { nativeProviderDescriptor } from "./native-provider-descriptor.js";
import { nativePolicyMethod } from "./native-provider-policy.js";
const callbackUrl = "https://operator.example/auth/native-connector.html";
function preset(id = "box") {
  const plan = connectPlan(id);
  const method = plan?.methods.find((entry) => entry.kind === "oauth");
  if (!plan || method?.kind !== "oauth" || !method.preset)
    throw new Error("Missing real compiled OAuth preset");
  return { plan, preset: method.preset };
}
it("defaults M365 to omit resource while preserving its verification URL", () => {
  const f = preset("m365");
  const descriptor = nativeOAuthResourceDescriptor(f.preset, callbackUrl, true);
  expect(
    descriptor.fields.find((row) => row.id === "resource_parameter"),
  ).toMatchObject({ defaultValue: "omit" });
  expect(
    descriptor.fields.find((row) => row.id === "resource")?.defaultValue,
  ).toBe("https://graph.microsoft.com/v1.0/me");
});

it("limits Google registered apps to the shared account-only contract", () => {
  const f = preset("google-drive");
  const profile = nativeBrowserOAuthProfile("google");
  if (!profile) throw new Error("Missing Google profile");
  const descriptor = nativeProviderDescriptor(f.plan, {
    callbackUrl,
    apiKey: { available: false },
    oauth: { available: false, registeredAvailable: true, profile },
    mcp: { available: false, actor: "user" },
  });
  const method = descriptor.methods.find((row) => row.id === "oauth");
  expect(method?.fields.map((field) => field.id)).not.toContain(
    "token_relay_url",
  );
  expect(method?.fields.map((field) => field.id)).not.toContain(
    "resource_protocol",
  );
  expect(
    method?.fields.find((field) => field.id === "resource_parameter"),
  ).toMatchObject({ defaultValue: "omit" });
  expect(method?.scopeGroups[0]?.requiredScopes).toEqual(["openid", "email"]);
});

it("keeps combined Google public and registered account forms on the shared policy", () => {
  const f = preset("google-drive");
  const profile = nativeBrowserOAuthProfile("google");
  if (!profile) throw new Error("Missing Google profile");
  const descriptor = nativeProviderDescriptor(f.plan, {
    callbackUrl,
    apiKey: { available: false },
    oauth: { available: true, registeredAvailable: true, profile },
    mcp: { available: false, actor: "user" },
  });
  const method = descriptor.methods.find((row) => row.id === "oauth");
  if (!method) throw new Error("Missing Google OAuth form");
  const required = method.scopeGroups[0]?.requiredScopes ?? [];
  expect(normalizeGoogleDriveAccountScopes("google-drive", required)).toEqual(
    GOOGLE_ACCOUNT_POLICY.scopes,
  );
  expect(nativeScopeDefaults(method).user).toEqual(
    expect.arrayContaining(required),
  );
  for (const field of GOOGLE_ACCOUNT_POLICY.forbiddenParameters)
    expect(method.fields.map((row) => row.id)).not.toContain(field);
});

it("derives standard configurable native OAuth from the actual confidential provider preset", () => {
  const f = preset();
  const descriptor = nativeProviderDescriptor(f.plan, {
    callbackUrl,
    apiKey: { available: false },
    oauth: { available: true },
    mcp: { available: false, actor: "user" },
  });
  const method = descriptor.methods.find((row) => row.id === "oauth");
  expect(method).toEqual(
    nativePolicyMethod(f.plan.id, {
      ...nativeOAuthResourceDescriptor(f.preset, callbackUrl, true),
      preferredRank: 35,
    }),
  );
  expect(
    method?.fields
      .filter((row) => row.secret)
      .every((row) => row.id === "client_secret"),
  ).toBe(true);
  expect(
    method?.fields.find((row) => row.id === "token_endpoint")?.defaultValue,
  ).toBe(f.preset.tokenEndpoint);
  expect(method?.fields.find((row) => row.id === "redirect_uri")).toMatchObject(
    { displayOnly: true, readOnly: true, defaultValue: callbackUrl },
  );
  expect(
    method?.fields.find((row) => row.id === "token_relay_url"),
  ).toMatchObject({ required: false });
  expect(method?.scopeGroups[0]?.choices).toEqual(f.preset.scopes);
});
it.each([
  "google",
  "dropbox",
  "spotify",
  "auth0",
  "twitch",
  "openrouter",
  "vercel",
  "microsoft",
])("preserves the mature %s public-profile descriptor exactly", (id) => {
  const plan = connectPlan(id);
  if (!plan) throw new Error("Missing public provider plan");
  const f = { plan };
  const profile = nativeBrowserOAuthProfile(id);
  if (!profile) throw new Error("Missing mature public profile");
  const descriptor = nativeProviderDescriptor(f.plan, {
    callbackUrl,
    apiKey: { available: false },
    oauth: { available: true, profile },
    mcp: { available: false, actor: "user" },
  });
  const configured = configuredNativeOAuthPreset(f.plan);
  const publicMethod = nativeBrowserOAuthDescriptor(
    f.plan,
    profile,
    callbackUrl,
  );
  const expectedBase = configured
    ? nativePublicApplicationDescriptor(
        configured.preset,
        callbackUrl,
        true,
        publicMethod,
        profile,
        {
          ...configured,
          resourceParameter:
            profile.mode === "google-token" ? "omit" : undefined,
          accountOnly: profile.mode === "google-token",
        },
      )
    : publicMethod;
  const expected = { ...expectedBase, preferredRank: 20 };
  const method = descriptor.methods.find((row) => row.id === "oauth");
  expect(method).toEqual(nativePolicyMethod(f.plan.id, expected));
  if (!method) throw new Error("Missing composed form");
  const values = nativeInitialValues(method);
  expect(
    nativeVisibleFields(method.fields, values)
      .filter((field) => field.id !== "token_auth_method")
      .map((field) => field.id),
  ).toEqual(publicMethod.fields.map((field) => field.id));
});
it("requires resubmitting the secret after editing an exact saved endpoint binding", () => {
  const method = nativeOAuthResourceDescriptor(
    preset().preset,
    callbackUrl,
    true,
  );
  const view = nativeUiView();
  view.configuration.method = "oauth";
  view.configuration.clientId = "operator-app";
  view.configuration.parameters = {
    issuer: "https://issuer.example",
    authorization_endpoint: "https://issuer.example/auth",
    token_endpoint: "https://issuer.example/token",
    resource: "https://api.example/projects",
    token_auth_method: "client_secret_basic",
  };
  const same = nativeInitialValues(method, view);
  expect(
    nativeMethodForEdit(method, view, same)
      .fields.filter((row) => row.secret)
      .every((row) => !row.required),
  ).toBe(true);
  const changed = { ...same, resource: "https://different.example/projects" };
  expect(
    nativeMethodForEdit(method, view, changed)
      .fields.filter((row) => row.secret)
      .every((row) => row.required),
  ).toBe(true);
  expect(nativeInitialValues(method, view).client_secret).toBe("");
  const scopes = view.configuration.requestedScopes;
  expect(
    nativeMethodForEdit(method, view, same, scopes).fields.find(
      (field) => field.secret,
    )?.help,
  ).toContain("Leave blank");
  const changedScopes = { user: [...(scopes.user ?? []), "new:permission"] };
  const changedMethod = nativeMethodForEdit(method, view, same, changedScopes);
  expect(
    changedMethod.fields
      .filter((field) => field.secret)
      .every((field) => field.required),
  ).toBe(true);
  expect(
    changedMethod.fields.some(
      (field) =>
        field.secret &&
        field.help?.includes("Leave blank to keep the saved credential."),
    ),
  ).toBe(false);
});

it.each(["resend", "workos"])(
  "offers genuine CIMD and registered client modes with unique visible fields for %s",
  (id) => {
    const f = preset(id);
    const profile = nativeBrowserOAuthProfile(id);
    if (!profile) throw new Error("Missing public profile");
    const descriptor = nativeProviderDescriptor(f.plan, {
      callbackUrl,
      apiKey: { available: false },
      oauth: { available: true, profile },
      mcp: { available: false, actor: "user" },
    });
    const method = descriptor.methods.find((row) => row.id === "oauth");
    if (!method) throw new Error("Missing common OAuth form");
    let values = nativeInitialValues(method);
    expect(values.token_auth_method).toBe("cimd");
    expect(
      nativeVisibleFields(method.fields, values).find(
        (row) => row.id === "client_id",
      )?.readOnly,
    ).toBe(true);
    for (const mode of [
      "none",
      "client_secret_basic",
      "client_secret_post",
      "cimd",
    ]) {
      values = nativeNextValues(
        method.fields,
        values,
        "token_auth_method",
        mode,
      );
      const visible = nativeVisibleFields(method.fields, values);
      expect(new Set(visible.map((row) => row.id)).size).toBe(visible.length);
      expect(visible.some((row) => row.secret)).toBe(
        mode === "client_secret_basic" || mode === "client_secret_post",
      );
      expect(visible.some((row) => row.id === "resource")).toBe(
        mode !== "cimd",
      );
      expect(
        visible.find((row) => row.id === "client_id")?.readOnly === true,
      ).toBe(mode === "cimd");
      if (mode !== "cimd")
        values.client_secret = "ephemeral unsaved credential";
      else expect(nativeFieldValues(method.fields, values, true)).toEqual({});
    }
  },
);
it("restores a strict registered target's selected mode without revealing its secret", () => {
  const f = preset("workos");
  const profile = nativeBrowserOAuthProfile("workos");
  if (!profile) throw new Error("Missing WorkOS profile");
  const descriptor = nativeProviderDescriptor(f.plan, {
    callbackUrl,
    apiKey: { available: false },
    oauth: { available: true, profile },
    mcp: { available: false, actor: "user" },
  });
  const method = descriptor.methods.find((row) => row.id === "oauth");
  if (!method) throw new Error("Missing OAuth form");
  const view = nativeUiView();
  view.configuration.method = "oauth";
  view.configuration.clientId = "operator-client";
  view.configuration.parameters = {
    issuer: "https://issuer.example",
    authorization_endpoint: "https://issuer.example/auth",
    token_endpoint: "https://issuer.example/token",
    resource: "https://issuer.example/resource",
    token_auth_method: "client_secret_post",
  };
  const values = nativeInitialValues(method, view);
  expect(values.token_auth_method).toBe("client_secret_post");
  expect(values.client_id).toBe("operator-client");
  expect(values.client_secret).toBe("");
  expect(
    nativeVisibleFields(method.fields, values).filter(
      (field) => field.id === "client_id",
    ),
  ).toHaveLength(1);
});

it.each<Record<string, string>>([
  { redirect_uri: callbackUrl },
  { token_auth_method: "none" },
  { issuer: "https://issuer.example" },
])(
  "refuses a malformed saved registered target before selecting any public driver: %j",
  (parameters) => {
    const view = nativeUiView();
    view.configuration.method = "oauth";
    view.configuration.clientId = "operator-registered";
    view.configuration.parameters = parameters;
    expect(() => nativeOAuthClientConfigured(view.configuration)).toThrow();
  },
);

it("initializes nested MCP defaults through the real public-to-registered mode change and clears hidden secrets", () => {
  const plan = connectPlan("vercel");
  const profile = nativeBrowserOAuthProfile("vercel");
  if (!plan || !profile) throw new Error("Missing real Vercel contract");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl,
    apiKey: { available: false },
    oauth: { available: true, registeredAvailable: true, profile },
    mcp: { available: false, actor: "user" },
  });
  const method = descriptor.methods.find((row) => row.id === "oauth");
  if (!method) throw new Error("Missing registered mode");
  let values = nativeInitialValues(method);
  expect(values.token_auth_method).toBe("provider");
  values = nativeNextValues(
    method.fields,
    values,
    "token_auth_method",
    "client_secret_post",
  );
  expect(values.resource_protocol).toBe("");
  values = nativeNextValues(method.fields, values, "resource_protocol", "mcp");
  expect(values).toMatchObject({
    resource_protocol: "mcp",
    mcp_transport: "streamable-http",
    mcp_endpoint: "https://mcp.vercel.com",
  });
  const visible = nativeVisibleFields(method.fields, values);
  expect(new Set(visible.map((field) => field.id)).size).toBe(visible.length);
  values.client_secret = "unsaved ephemeral value";
  values = nativeNextValues(
    method.fields,
    values,
    "token_auth_method",
    "provider",
  );
  expect(nativeFieldValues(method.fields, values, true)).toEqual({});
  expect(values).not.toHaveProperty("mcp_endpoint");
  expect(values).not.toHaveProperty("client_secret");
});
