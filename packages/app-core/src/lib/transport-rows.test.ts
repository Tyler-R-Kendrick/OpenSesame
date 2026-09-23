import { describe, expect, it } from "vitest";
import { parseTransportStatusView } from "./transport-model.js";
import {
  enforcementIsStale,
  policyLabel,
  toTransportViewState,
} from "./transport-rows.js";
import {
  FIXTURE_NOW,
  transportStatusWire,
} from "./transport-status.fixture.js";
import type { TransportStatusResult } from "./transport-status.js";

function result(overrides = {}): TransportStatusResult {
  const view = parseTransportStatusView(transportStatusWire(overrides));
  if (!view) throw new Error("fixture must parse");
  return { kind: "view", view, fetchedAt: "2026-09-22T12:00:00Z" };
}

const ids = (state: ReturnType<typeof toTransportViewState>) =>
  state.rows.map((row) => row.id);

describe("toTransportViewState", () => {
  it("draws five idle rows when nothing has been asked", () => {
    const state = toTransportViewState(null, "existing_local", FIXTURE_NOW);
    expect(ids(state)).toEqual([
      "desired",
      "credential",
      "runtime",
      "observed",
      "enforcement",
    ]);
    expect(state.rows[0]?.facts).toBe("existing local");
    for (const row of state.rows.slice(1)) {
      expect(row.tone).toBe("idle");
      expect(row.state).toBe("Not checked");
      expect(row.facts).toBe("");
    }
    expect(state.stale).toBe(false);
    expect(state.target).toBeNull();
    expect(
      toTransportViewState({ kind: "unconfigured" }, "server_tls", FIXTURE_NOW)
        .rows[1]?.tone,
    ).toBe("idle");
  });

  it("keeps a full verified answer as five separate rows", () => {
    const state = toTransportViewState(result(), "mtls_required", FIXTURE_NOW);
    expect(state.target).toBe("host-tls");
    expect(state.stale).toBe(false);
    expect(state.rows.map((row) => [row.id, row.tone])).toEqual([
      ["desired", "ok"],
      ["credential", "ok"],
      ["runtime", "ok"],
      ["observed", "ok"],
      ["enforcement", "ok"],
    ]);
    expect(state.rows[4]?.state).toBe("Verified: certificate required");
    expect(state.rows[3]?.facts).toContain("transport.probe → host-tls");
  });

  it("marks a desired policy the endpoint does not run", () => {
    const state = toTransportViewState(result(), "server_tls", FIXTURE_NOW);
    expect(state.rows[0]?.tone).toBe("warn");
    expect(state.rows[0]?.facts).toBe("server TLS · endpoint mTLS required");
  });

  it("AT-EVIDENCE-POSITIVE: accepted with a certificate is not enforcement", () => {
    const state = toTransportViewState(
      result({
        enforcement: {
          verified: {
            at: "2026-09-22T11:00:00Z",
            target: "host-tls",
            generation: 3,
            accepted_with_certificate: true,
            rejected_without_certificate: false,
            fresh_until: "2026-09-22T13:00:00Z",
          },
        },
      }),
      "mtls_required",
      FIXTURE_NOW,
    );
    expect(state.rows[3]?.tone).toBe("ok");
    expect(state.rows[4]?.tone).toBe("warn");
    expect(state.rows[4]?.state).toBe("Accepted, not required");
  });

  it("AT-EVIDENCE-STALE: a later generation or a passed fresh_until makes evidence stale", () => {
    const moved = result({
      runtime: { loaded: { generation: 4, loaded_at: "2026-09-22T11:30:00Z" } },
    });
    const byGeneration = toTransportViewState(
      moved,
      "mtls_required",
      FIXTURE_NOW,
    );
    expect(byGeneration.stale).toBe(true);
    expect(byGeneration.rows[4]?.state).toBe("Stale");
    expect(byGeneration.rows[2]?.tone).toBe("ok");

    const byClock = toTransportViewState(
      result(),
      "mtls_required",
      Date.parse("2026-09-22T13:00:01Z"),
    );
    expect(byClock.stale).toBe(true);

    const reported = toTransportViewState(
      result({
        enforcement: {
          stale: {
            verified_at: "2026-09-22T09:00:00Z",
            generation: 2,
            current_generation: 3,
          },
        },
      }),
      "mtls_required",
      FIXTURE_NOW,
    );
    expect(reported.stale).toBe(true);
    expect(reported.rows[4]?.facts).toBe("verified gen 2 · now gen 3");

    if (moved.kind === "view")
      expect(enforcementIsStale(moved.view, FIXTURE_NOW)).toBe(true);
  });

  it("reads expired, revoked, reload failure and an external credential", () => {
    expect(
      toTransportViewState(
        result({ credential: { expired: { generation: 3 } } }),
        "mtls_required",
        FIXTURE_NOW,
      ).rows[1],
    ).toMatchObject({ tone: "err", state: "Expired" });
    expect(
      toTransportViewState(
        result({ credential: { revoked: { generation: 3 } } }),
        "mtls_required",
        FIXTURE_NOW,
      ).rows[1],
    ).toMatchObject({ tone: "err", state: "Revoked" });
    expect(
      toTransportViewState(
        result({ credential: "external_provisioning_required" }),
        "mtls_required",
        FIXTURE_NOW,
      ).rows[1],
    ).toMatchObject({ tone: "warn" });
    expect(
      toTransportViewState(
        result({ credential: "unsupported_in_browser" }),
        "mtls_required",
        FIXTURE_NOW,
      ).rows[1],
    ).toMatchObject({ tone: "warn" });
    expect(
      toTransportViewState(
        result({
          runtime: { reload_failed: { generation: 3, code: "trust_unknown" } },
        }),
        "mtls_required",
        FIXTURE_NOW,
      ).rows[2],
    ).toMatchObject({ tone: "err", facts: "gen 3 · trust_unknown" });
    expect(
      toTransportViewState(
        result({ observed: null, enforcement: "unverified" }),
        "mtls_required",
        FIXTURE_NOW,
      )
        .rows.slice(3)
        .map((r) => r.tone),
    ).toEqual(["idle", "idle"]);
  });

  it("shows a degraded, unauthorized or malformed answer on the observed row only", () => {
    const degraded = toTransportViewState(
      { kind: "degraded", failure: "unreachable", status: null },
      "server_tls",
      FIXTURE_NOW,
    );
    expect(degraded.rows.map((row) => row.tone)).toEqual([
      "idle",
      "idle",
      "idle",
      "err",
      "idle",
    ]);
    expect(degraded.rows[3]?.facts).toBe("no answer");
    expect(
      toTransportViewState(
        { kind: "unauthorized", status: 401 },
        "server_tls",
        FIXTURE_NOW,
      ).rows[3],
    ).toMatchObject({ tone: "warn", state: "Not authorized to read status" });
    expect(
      toTransportViewState({ kind: "malformed" }, "server_tls", FIXTURE_NOW)
        .rows[3],
    ).toMatchObject({ tone: "warn", state: "Answer not understood" });
  });

  it("labels every policy", () => {
    expect(policyLabel("mtls_required")).toBe("mTLS required");
    expect(policyLabel("trusted_ingress")).toBe("trusted ingress");
  });
});
