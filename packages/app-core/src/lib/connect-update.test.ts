import type { JsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  draftStateFromDetail,
  initialDraftState,
  toConnectorDraft,
  withParam,
} from "./connect-draft.js";
import { type ConnectPlan, connectPlan } from "./connect-plan.js";
import { updateBody, updateProblems } from "./connect-update.js";
import { connectorDetailFrom } from "./vercel-connect-manage.js";
import { assertConnectAcceptsUpdate } from "./vercel-connect-schema.test-support.js";

function planOf(id: string): ConnectPlan {
  const plan = connectPlan(id);
  if (!plan) throw new Error(`no plan for ${id}`);
  return plan;
}

/** A connector as Connect might answer it: only what it chose to echo. */
function held(plan: ConnectPlan, data: JsonObject, type = "oauth") {
  const detail = connectorDetailFrom({
    connector: { id: "scl_1", uid: `${plan.id}/w`, name: "w", type, data },
  });
  if (!detail) throw new Error("no detail");
  return draftStateFromDetail(plan, detail);
}

describe("saving a connector's settings", () => {
  const notion = planOf("notion");

  it("sends a rename alone — never the client, PKCE or refresh it did not touch", () => {
    // Connect echoed the client id and nothing about PKCE or refresh.
    const before = held(notion, { clientId: "cid" });
    const after = { ...before, name: "renamed" };
    expect(
      updateBody(toConnectorDraft(after), toConnectorDraft(before)),
    ).toEqual({ name: "renamed" });
  });

  it("never sends a blank client ID over a stored one", () => {
    // An assisted connector: Connect registered the client and echoes none.
    const before = held(notion, {});
    const after = { ...before, name: "renamed" };
    const body = updateBody(toConnectorDraft(after), toConnectorDraft(before));
    expect(JSON.stringify(body)).not.toMatch(/clientId/);
  });

  it("sends what changed, clearing a field the way Connect's update schema does", () => {
    const before = held(notion, {
      clientId: "cid",
      codeChallengeMethod: "S256",
      pkceRequired: false,
      refreshTokens: { enabled: true },
      authorizationUrlParams: { prompt: "consent" },
      serverConfig: {
        authorization_endpoint: "https://api.notion.com/v1/oauth/authorize",
        token_endpoint: "https://api.notion.com/v1/oauth/token",
        revocation_endpoint: "https://api.notion.com/v1/oauth/revoke",
      },
    });
    const after = {
      ...before,
      oauth: {
        ...before.oauth,
        pkce: "none" as const,
        refreshTokens: false,
        authorizationParams: {},
        revocationEndpoint: "",
      },
    };
    const body = updateBody(toConnectorDraft(after), toConnectorDraft(before));
    expect(body.data).toMatchObject({
      codeChallengeMethod: "",
      authorizationUrlParams: {},
      refreshTokens: { enabled: false },
      serverConfig: { revocation_endpoint: "" },
    });
    expect(JSON.stringify(body)).not.toContain("null");
    assertConnectAcceptsUpdate(body, "oauth");
  });

  it("sends an API key connector's instructions and key, and refuses a URL or subject edit", () => {
    const openai = planOf("openai");
    const before = held(
      openai,
      {
        serviceUrls: ["https://api.openai.com"],
        subjectType: "app",
        instructions: "old",
      },
      "api-key",
    );
    const keyed = { ...before, key: "sk-new", instructions: "Paste yours." };
    const body = updateBody(toConnectorDraft(keyed), toConnectorDraft(before));
    expect(body.data).toEqual({
      instructions: "Paste yours.",
      toAdd: [{ value: "sk-new" }],
    });
    assertConnectAcceptsUpdate(body, "api-key");
    const moved = {
      ...before,
      keySubject: "user" as const,
      serviceUrls: ["https://api.openai.com/v1"],
    };
    expect(
      updateProblems(toConnectorDraft(moved), toConnectorDraft(before)),
    ).toEqual([
      "The API and whose key are set when the connector is created; create another to change them.",
    ]);
    expect(
      JSON.stringify(
        updateBody(toConnectorDraft(moved), toConnectorDraft(before)),
      ),
    ).not.toMatch(/serviceUrls|subjectType/);
  });

  it("refuses an edit that introduces a problem, and only that", () => {
    // The stored secret is never read back: that is not the edit's to fix.
    const before = held(notion, { clientId: "cid" });
    expect(
      updateProblems(
        toConnectorDraft({ ...before, name: "n" }),
        toConnectorDraft(before),
      ),
    ).toEqual([]);
    const cleared = { ...before, oauth: { ...before.oauth, clientId: "" } };
    expect(
      updateProblems(toConnectorDraft(cleared), toConnectorDraft(before)),
    ).toContain("Paste the client ID.");
    const plain = {
      ...before,
      oauth: { ...before.oauth, tokenEndpoint: "http://insecure.test/t" },
    };
    expect(
      updateProblems(toConnectorDraft(plain), toConnectorDraft(before)),
    ).toContain("Token endpoint must be https.");
  });

  it("reads silence about PKCE and refresh as the preset's, not as off", () => {
    const before = held(notion, {});
    const preset = notion.methods.find((m) => m.kind === "oauth");
    expect(preset?.kind === "oauth" && preset.preset).toBeTruthy();
    if (preset?.kind !== "oauth" || !preset.preset) return;
    expect(before.oauth.pkce).toBe(preset.preset.pkce);
    expect(before.oauth.refreshTokens).toBe(preset.preset.refreshTokens);
  });
});

describe("filling a placeholder", () => {
  it("fills every field still holding the preset, and keeps a hand edit", () => {
    const okta = planOf("okta");
    let state = initialDraftState(okta, "oauth");
    state = {
      ...state,
      oauth: { ...state.oauth, tokenEndpoint: "https://idp.example/token" },
    };
    for (const letter of ["a", "ac", "acme.okta.com"]) {
      state = withParam(state, okta, "domain", letter);
    }
    expect(state.oauth.authorizationEndpoint).toContain("acme.okta.com");
    expect(state.oauth.authorizationEndpoint).not.toMatch(/\{domain\}/);
    expect(state.oauth.tokenEndpoint).toBe("https://idp.example/token");
  });
});
