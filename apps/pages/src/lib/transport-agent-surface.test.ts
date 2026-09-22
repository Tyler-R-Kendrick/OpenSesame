import {
  CAPABILITIES,
  assertsNoSecretNames,
} from "@opensesame/capability-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, saveSettings } from "./settings.js";
import {
  TRANSPORT_AGENT_TOOLS,
  TRANSPORT_STATUS_VIEW_CANDIDATE,
  TRANSPORT_STATUS_VIEW_TOOL,
  assertsTransportToolsReferenceOnly,
  transportStatusForAgent,
} from "./transport-agent-surface.js";
import { parseTransportStatusView } from "./transport-model.js";
import { transportStatusWire } from "./transport-status.fixture.js";
import {
  readTransportStatus,
  resetTransportStatusForTests,
  transportStatusSeams,
} from "./transport-status.js";

const originalSeams = { ...transportStatusSeams };
const globalFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", globalFetch);
  transportStatusSeams.fetch = vi.fn();
  transportStatusSeams.hostLocalSessionEligible = () => false;
  resetTransportStatusForTests();
  saveSettings({ ...loadSettings(), hostApi: "" });
});

afterEach(() => {
  Object.assign(transportStatusSeams, originalSeams);
  vi.unstubAllGlobals();
});

describe("transport agent surface (UI-AGENTS)", () => {
  it("ships nothing while the registry excludes transport.status.view from WebMCP (ADR 0132)", () => {
    const entry = CAPABILITIES.find((c) => c.id === "transport.status.view");
    expect(entry?.excluded?.webmcp?.adr).toMatch(/^0132-/);
    expect(TRANSPORT_AGENT_TOOLS).toEqual([]);
  });

  it("the candidate is one read-only, session-scoped view carrying transport.status.view", () => {
    const tool = TRANSPORT_STATUS_VIEW_CANDIDATE;
    expect(tool.name).toBe(TRANSPORT_STATUS_VIEW_TOOL);
    expect(tool.readOnly).toBe(true);
    expect(tool.scope).toBe("session");
    expect(tool.capabilityIds).toEqual(["transport.status.view"]);
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("never fetches, even with an endpoint set", async () => {
    saveSettings({
      ...loadSettings(),
      hostApi: "https://authority.example.test",
    });
    const answer = await TRANSPORT_STATUS_VIEW_CANDIDATE.execute({});
    expect(answer).toMatchObject({
      status: "not_checked",
      target: null,
      stale: false,
    });
    expect(transportStatusSeams.fetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("projects the last read status as names and outcomes — no address, no material", async () => {
    saveSettings({
      ...loadSettings(),
      hostApi: "https://authority.example.test",
    });
    transportStatusSeams.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(transportStatusWire()), { status: 200 }),
    );
    await readTransportStatus();
    const answer = transportStatusForAgent();
    expect(answer.status).toBe("view");
    expect(answer.target).toBe("host-tls");
    expect(answer.rows.map((row) => row.dimension)).toEqual([
      "credential",
      "runtime",
      "observed",
      "enforcement",
    ]);
    expect(answer.browser.browser_vault_key_injection.kind).toBe("unsupported");
    const text = JSON.stringify(answer);
    expect(text).not.toMatch(/https?:|authority\.example|BEGIN|\/api\//);
    expect(text).not.toContain("ab".repeat(32));
    expect(parseTransportStatusView(transportStatusWire())).not.toBeNull();
  });

  it("names no tool that could register trust, move custody, reveal a key or provision a source", () => {
    const names = [TRANSPORT_STATUS_VIEW_CANDIDATE.name];
    expect(() => assertsTransportToolsReferenceOnly(names)).not.toThrow();
    expect(() => assertsNoSecretNames(names)).not.toThrow();
    for (const forbidden of [
      "opensesame_transport_trust_register",
      "opensesame_transport_key_reveal",
      "opensesame_transport_custody_move",
      "opensesame_transport_provision_native",
      "opensesame_transport_csr",
      "opensesame_transport_verify",
      "opensesame_transport_binding_set",
    ]) {
      expect(() => assertsTransportToolsReferenceOnly([forbidden])).toThrow(
        "transport_tool_forbidden",
      );
    }
  });
});
