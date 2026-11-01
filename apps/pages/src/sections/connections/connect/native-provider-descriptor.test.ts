import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { nativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import { bindNativeBrowserPolicyOrigin } from "@opensesame/app-core/lib/native-browser-policy.js";
import { describe, expect, it } from "vitest";
import { nativeInitialMethod } from "./native-connector-edit-values.js";
import type { NativeConnectorDescriptor } from "./native-connector-ui.js";
import { nativeGithubDescriptor } from "./native-github-descriptor.js";
import { nativeProviderDescriptor } from "./native-provider-descriptor.js";

describe("compiled provider credential variants", () => {
  it.each([true, false])(
    "retains compiled variants and CORS advice without promoting unavailable runtime: %s",
    (available) => {
      const original = connectPlan("railway");
      if (!original) throw new Error("Expected compiled Railway provider");
      const plan = structuredClone(original);
      const method = plan.methods.find((entry) => entry.kind === "api-key");
      if (
        method?.kind !== "api-key" ||
        !method.preset?.credentialVariants.length
      )
        throw new Error("Expected official credential variants");
      method.preset.auth = null;
      method.preset.verify = null;
      const descriptor = nativeProviderDescriptor(plan, {
        callbackUrl: "https://app.example/auth/native-connector.html",
        apiKey: { available },
        oauth: { available: false },
        mcp: { available: false, actor: "user" },
      });
      const api = descriptor.methods.find((entry) => entry.id === "api-key");
      expect(api?.available).toBe(available);
      expect(api?.instructions).toContain("browser access");
      expect(
        api?.fields
          .find((field) => field.id === "credential_variant")
          ?.choices?.map((choice) => choice.id),
      ).toEqual(["account", "workspace", "project"]);
      expect(
        api?.fields
          .filter((field) => field.id === "api_key")
          .every((field) => field.secret),
      ).toBe(true);
    },
  );
});

it("keeps the client-secret field when a Google popup is refused", () => {
  const plan = connectPlan("google");
  const profile = nativeBrowserOAuthProfile("google");
  if (!plan || !profile) throw new Error("Expected Google OAuth profile");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl: "https://app.example/auth/native-connector.html",
    apiKey: { available: true },
    oauth: {
      available: false,
      registeredAvailable: true,
      profile,
    },
    mcp: { available: false, actor: "user" },
  });
  const oauth = descriptor.methods.find((method) => method.id === "oauth");
  expect(oauth?.fields.some((field) => field.id === "client_secret")).toBe(
    true,
  );
});

it("exposes configured WorkOS fields without promoting a missing runtime", () => {
  const plan = connectPlan("workos");
  if (!plan) throw new Error("Expected compiled WorkOS provider");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl: "https://app.example/auth/native-connector.html",
    apiKey: { available: false },
    oauth: { available: false },
    mcp: { available: true, actor: "user" },
  });
  const oauth = descriptor.methods.find((method) => method.id === "oauth");
  expect(oauth?.available).toBe(false);
  expect(oauth?.unavailableReason).toContain("External connectors");
  expect(oauth?.fields.some((field) => field.id === "token_auth_method")).toBe(
    true,
  );
  expect(oauth?.unavailableReason).not.toContain("client secret");
});

it.each([
  { origin: "https://opensesame-labs.github.io", admitted: false },
  { origin: "https://app.example", admitted: true },
])(
  "applies MCP admission at $origin while keeping API advice and OAuth refusal distinct",
  ({ origin, admitted }) => {
    const releaseOrigin = bindNativeBrowserPolicyOrigin(() => origin);
    try {
      const plan = connectPlan("resend");
      if (!plan) throw new Error("Missing Resend contract");
      const descriptor = nativeProviderDescriptor(plan, {
        callbackUrl: `${origin}/auth/native-connector.html`,
        apiKey: { available: true },
        oauth: { available: true },
        mcp: { available: true, actor: "user" },
      });
      expect(
        descriptor.methods
          .filter((method) => method.available)
          .map((method) => method.id),
      ).toEqual(admitted ? ["mcp", "api-key"] : ["api-key"]);
      expect(
        descriptor.methods.find((method) => method.id === "mcp")?.available,
      ).toBe(admitted);
      if (!admitted)
        expect(
          descriptor.methods.find((method) => method.id === "mcp")
            ?.unavailableReason,
        ).toBe("Resend MCP is unavailable from this site's origin.");
      for (const method of descriptor.methods.filter(
        (method) => method.id === "oauth",
      ))
        expect(method.unavailableReason).toContain("Resend");
    } finally {
      releaseOrigin();
    }
  },
);
it("keeps officially browser-supported Notion API configuration available", () => {
  const plan = connectPlan("notion");
  if (!plan) throw new Error("Missing Notion contract");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl: "https://app.example/auth/native-connector.html",
    apiKey: { available: true },
    oauth: { available: false },
    mcp: { available: false, actor: "user" },
  });
  expect(
    descriptor.methods.find((method) => method.id === "api-key")?.available,
  ).toBe(true);
});

it("offers explicit MCP credential modes when published public OAuth metadata is incomplete, without inventing an auth contract", () => {
  const plan = connectPlan("hugging-face");
  if (!plan) throw new Error("Missing real incomplete MCP contract");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl: "https://operator.example/auth/native-connector.html",
    apiKey: { available: false },
    oauth: { available: true, registeredAvailable: true },
    mcp: { available: true, actor: "user" },
  });
  const method = descriptor.methods.find((row) => row.id === "mcp");
  expect(method?.fields[0]).toMatchObject({
    id: "mcp_authentication",
    defaultValue: "",
  });
  expect(method?.fields[0]?.choices?.map((row) => row.id)).toEqual([
    "bearer",
    "header",
    "anonymous",
  ]);
  expect(
    method?.fields.some(
      (field) =>
        field.id === "mcp_url" &&
        field.defaultValue === "https://huggingface.co/mcp?login&gradio=none",
    ),
  ).toBe(true);
  expect(
    method?.fields.some(
      (field) =>
        field.id === "token_endpoint" || field.id === "authorization_endpoint",
    ),
  ).toBe(false);
});

it("composes the same optional encrypted backup target fields for Codeberg OAuth and GitHub token flows", () => {
  const plan = connectPlan("codeberg");
  const profile = nativeBrowserOAuthProfile("codeberg");
  const github = catalogProvider("github");
  if (!plan || !profile || !github)
    throw new Error("Missing native provider contracts");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl: "https://app.example/auth/native-connector.html",
    apiKey: { available: false },
    oauth: { available: true, profile },
    mcp: { available: false, actor: "user" },
  });
  const oauth = descriptor.methods.find((method) => method.id === "oauth");
  const fields = oauth?.fields.filter((field) =>
    field.id.startsWith("backup_"),
  );
  expect(
    fields?.map((field) => ({
      id: field.id,
      label: field.label,
      kind: field.kind,
      secret: field.secret,
      required: field.required,
    })),
  ).toEqual(
    nativeGithubDescriptor(github, true)
      .methods[0]?.fields.filter((field) => field.id.startsWith("backup_"))
      .map((field) => ({
        id: field.id,
        label: field.label,
        kind: field.kind,
        secret: field.secret,
        required: field.required,
      })),
  );
  expect(fields?.map((field) => field.id)).toEqual([
    "backup_owner",
    "backup_repo",
    "backup_branch",
  ]);
  expect(oauth?.scopeGroups).toEqual([]);
  expect(oauth?.instructions).toContain("without granular permission scopes");
});

it("prefers the simplest secure method: MCP CIMD, public OAuth, then API key", () => {
  const callbackUrl = "https://app.example/auth/native-connector.html";
  const release = bindNativeBrowserPolicyOrigin(() => "https://app.example");
  try {
    const initial = (id: string) => {
      const plan = connectPlan(id);
      if (!plan) throw new Error(`Missing ${id}`);
      const profile = nativeBrowserOAuthProfile(id) ?? undefined;
      const descriptor = nativeProviderDescriptor(plan, {
        callbackUrl,
        apiKey: { available: true },
        oauth: {
          available: profile !== undefined,
          registeredAvailable: true,
          profile,
        },
        mcp: { available: true, actor: "user" },
      });
      return nativeInitialMethod(descriptor)?.id;
    };
    expect(initial("resend")).toBe("mcp");
    expect(initial("gitlab")).toBe("oauth");
    expect(initial("clickup")).toBe("api-key");
    expect(initial("box")).toBe("mcp");
    expect(initial("notion")).toBe("mcp");
  } finally {
    release();
  }
});

it("does not open a new connection on a configurable but blocked method", () => {
  const descriptor = {
    providerId: "example",
    name: "Example",
    docsUrl: null,
    actions: [],
    methods: [
      {
        id: "mcp",
        label: "MCP",
        available: false,
        configurable: true,
        preferredRank: 10,
        fields: [],
        scopeGroups: [],
      },
      {
        id: "oauth",
        label: "OAuth",
        available: true,
        preferredRank: 20,
        fields: [],
        scopeGroups: [],
      },
    ],
  } satisfies NativeConnectorDescriptor;
  expect(nativeInitialMethod(descriptor)?.id).toBe("oauth");
});
