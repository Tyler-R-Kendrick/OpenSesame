import type { JsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { updateBody, updateProblems } from "./connect-create.js";
import {
  draftStateFromDetail,
  initialDraftState,
  toConnectorDraft,
  withParam,
} from "./connect-draft.js";
import { type ConnectPlan, connectPlan } from "./connect-plan.js";
import { connectorDetailFrom } from "./vercel-connect-manage.js";

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

  it("sends what changed, and a cleared field as null", () => {
    const before = held(notion, {
      clientId: "cid",
      codeChallengeMethod: "S256",
      pkceRequired: false,
      refreshTokens: { enabled: true },
    });
    const after = {
      ...before,
      oauth: { ...before.oauth, pkce: "none" as const, refreshTokens: false },
    };
    const body = updateBody(toConnectorDraft(after), toConnectorDraft(before));
    expect(body.data).toMatchObject({
      codeChallengeMethod: null,
      refreshTokens: { enabled: false },
    });
    expect(Object.keys(body)).toEqual(["data"]);
  });

  it("sends an API key connector's URL and subject edits", () => {
    const openai = planOf("openai");
    const before = held(
      openai,
      { serviceUrls: ["https://api.openai.com"], subjectType: "user" },
      "api-key",
    );
    const after = {
      ...before,
      keySubject: "app" as const,
      key: "sk-new",
      serviceUrls: ["https://api.openai.com/v1"],
    };
    const body = updateBody(toConnectorDraft(after), toConnectorDraft(before));
    expect(body.data).toEqual({
      serviceUrls: ["https://api.openai.com/v1"],
      subjectType: "app",
      toAdd: [{ value: "sk-new" }],
    });
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
