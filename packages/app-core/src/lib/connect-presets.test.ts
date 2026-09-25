import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { renderModule } from "../../scripts/emit-connect-presets.mjs";
import {
  authorizeBody,
  createBody,
  draftProblems,
  oauthDraftFrom,
  updateBody,
} from "./connect-create.js";
import {
  connectSubjectId,
  initialDraftState,
  toConnectorDraft,
  withParam,
} from "./connect-draft.js";
import {
  type ConnectPlan,
  connectPlan,
  connectPlans,
  fillTemplate,
  hasOpenTemplate,
  isConnectable,
  preferredMethod,
} from "./connect-plan.js";
import { CONNECT_PLAN_JSON } from "./connect-presets.generated.js";
import { assertConnectAccepts } from "./vercel-connect-schema.test-support.js";

const here = dirname(fileURLToPath(import.meta.url));
const services = JSON.parse(
  readFileSync(
    join(here, "../../../../spec/connectors/connect-services.json"),
    "utf8",
  ),
);

/** What a person would type: a client, a key, and any domain the preset names. */
function filled(
  plan: ConnectPlan,
  kind: ConnectPlan["methods"][number]["kind"],
) {
  let state = initialDraftState(plan, kind);
  const method = plan.methods.find((m) => m.kind === kind);
  const params =
    method?.kind === "oauth"
      ? (method.preset?.templateParams ?? [])
      : method?.kind === "api-key"
        ? (method.preset?.templateParams ?? [])
        : [];
  for (const param of params)
    state = withParam(state, plan, param.name, "acme.example.com");
  if (kind === "oauth" && !state.oauth.serverUrl) {
    state = {
      ...state,
      oauth: {
        ...state.oauth,
        serverUrl: "https://auth.example.com",
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
      },
    };
  }
  return {
    ...state,
    oauth: {
      ...state.oauth,
      clientId: "client-id",
      clientSecret: "client-secret",
    },
    mcpClientId: "client-id",
    mcpClientSecret: "client-secret",
    keySubject: "app" as const,
    key: "key-value",
    serviceUrls: state.serviceUrls.length
      ? state.serviceUrls.map((url) =>
          fillTemplate(url, {
            ...Object.fromEntries(params.map((p) => [p.name, "acme"])),
          }),
        )
      : ["https://api.example.com"],
  };
}

describe("connector plans", () => {
  it("embeds exactly what the specs say", () => {
    const rendered = renderModule();
    expect(rendered).toContain(`"${services.pinned_at}"`);
    const fromSpecs = rendered
      .split("\n")
      .filter((line: string) => line.startsWith('  "{'))
      .map((line: string) =>
        JSON.parse(JSON.parse(line.trim().replace(/,$/, ""))),
      );
    expect(CONNECT_PLAN_JSON.map((json) => JSON.parse(json))).toEqual(
      fromSpecs,
    );
  });

  it("covers every service in Vercel Connect's registry", () => {
    for (const row of services.services) {
      expect(connectPlan(row.service), row.service).toBeDefined();
    }
  });

  it("offers a way in for every connectable service — no blank page", () => {
    const blank = connectPlans().filter(
      (plan) => !plan.refused && plan.methods.length === 0,
    );
    expect(blank.map((plan) => plan.id)).toEqual([]);
    for (const plan of connectPlans().filter(isConnectable)) {
      expect(preferredMethod(plan), plan.id).toBeDefined();
    }
  });

  it("refuses payment rails", () => {
    expect(connectPlan("stripe")?.refused).toBe(true);
    expect(connectPlan("resend")?.refused).toBe(false);
  });

  it("fills and reports placeholders", () => {
    expect(
      fillTemplate("https://{domain}/oauth2", {
        domain: "https://acme.okta.com/",
      }),
    ).toBe("https://acme.okta.com/oauth2");
    expect(hasOpenTemplate("https://{domain}/x")).toBe(true);
    expect(
      hasOpenTemplate(fillTemplate("https://{domain}/x", { domain: "a" })),
    ).toBe(false);
  });
});

describe("create bodies Connect accepts, for every plan and method", () => {
  const cases = connectPlans()
    .filter(isConnectable)
    .flatMap((plan) =>
      plan.methods.map((method) => [plan, method.kind] as const),
    );

  it.each(
    cases.map(([plan, kind]) => [`${plan.id} · ${kind}`, plan, kind] as const),
  )("%s", (_label, plan, kind) => {
    const draft = toConnectorDraft(filled(plan, kind));
    expect(draftProblems(draft)).toEqual([]);
    const body = createBody(plan, draft);
    assertConnectAccepts(body);
    expect(body.service).toBeTruthy();
    if (kind === "oauth") {
      // Never a bare service: the OAuth server and client ride along.
      const data = readJsonObject(body.data) ?? {};
      expect(data.clientId).toBe("client-id");
      expect(data.serverConfig).toBeTruthy();
    }
  });
});

describe("drafts", () => {
  const resend = connectPlan("resend");

  it("opens on the method that asks the least", () => {
    if (!resend) throw new Error("resend plan missing");
    expect(initialDraftState(resend).method).toBe("mcp");
  });

  it("names what is missing instead of creating a blank connector", () => {
    const google = connectPlan("google");
    if (!google) throw new Error("google plan missing");
    const draft = toConnectorDraft(initialDraftState(google, "oauth"));
    expect(draftProblems(draft).join(" ")).toMatch(/client ID/);
  });

  it("lets Vercel register the client where the server registers its own", () => {
    if (!resend) throw new Error("resend plan missing");
    const draft = toConnectorDraft(initialDraftState(resend, "oauth"));
    expect(draftProblems(draft)).toEqual([]);
    const body = createBody(resend, draft);
    expect(body).toMatchObject({
      service: "resend",
      connectionMethod: "oauth",
    });
    assertConnectAccepts(body);
  });

  it("keeps a stored client secret when the field is left blank", () => {
    const preset = connectPlans()
      .flatMap((plan) => plan.methods)
      .find((method) => method.kind === "oauth" && method.preset);
    if (preset?.kind !== "oauth" || !preset.preset) return;
    const oauth = { ...oauthDraftFrom(preset.preset), clientId: "c" };
    const body = updateBody({ kind: "oauth", name: "n", uid: "", oauth });
    expect(JSON.stringify(body)).not.toMatch(/clientSecret/);
  });

  it("authorizes on behalf of a person", () => {
    expect(authorizeBody({ type: "user", id: "prn_1" }, ["read"])).toEqual({
      subject: { type: "user", id: "prn_1" },
      scopes: ["read"],
    });
  });

  it("keys a person's tokens by principal, or by the vault when signed out", () => {
    expect(connectSubjectId("prn_1", "tomb")).toBe("prn_1");
    expect(connectSubjectId(null, "t0mb/x")).toBe("local-t0mbx");
    expect(connectSubjectId(" ", "")).toBeNull();
  });
});

describe("one definition (ADR 0139)", () => {
  // SAFETY: fixture — the checked-in catalog.json matches this schema (ADR 0139).
  const catalog = JSON.parse(
    readFileSync(
      join(here, "../../../../spec/connectors/catalog.json"),
      "utf8",
    ),
  ) as {
    providers: {
      id: string;
      auth: {
        kind: string;
        authorize_url?: string;
        token_url?: string;
        token_auth?: string;
      };
    }[];
  };

  it("agrees with the integration catalog wherever both describe a provider", () => {
    const drift: string[] = [];
    for (const row of catalog.providers) {
      if (row.auth.kind !== "oauth2_authorization_code") continue;
      const method = connectPlan(row.id)?.methods.find(
        (m) => m.kind === "oauth",
      );
      if (method?.kind !== "oauth" || !method.preset) continue;
      const p = method.preset;
      if (p.authorizationEndpoint !== row.auth.authorize_url)
        drift.push(`${row.id} authorize`);
      if (p.tokenEndpoint !== row.auth.token_url) drift.push(`${row.id} token`);
      if (p.tokenAuth !== row.auth.token_auth)
        drift.push(`${row.id} client auth`);
    }
    expect(drift).toEqual([]);
  });
});
