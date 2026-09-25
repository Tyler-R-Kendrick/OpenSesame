/**
 * A stand-in for the Identity API's notification-routing routes, for the
 * panel tests: channels, bindings, preferences and one effective route per
 * class planned the way `planNotificationRoute` plans it — policy ∩
 * preference ∩ live bindings ∩ configured adapters, the inbox appended.
 *
 * Policy here refuses Push for authorization requests and allows it for
 * security events, so a test can show a preference narrowing and failing to
 * widen.
 */

import type { RoutingTransport } from "@opensesame/app-core/lib/notification-routing/transport.js";
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { vi } from "vitest";

type Pref = { channels: string[]; fanOut: boolean };

const POLICY = {
  authorization_request: ["in_app", "telegram", "slack"],
  authorization_decision: ["in_app", "telegram"],
  security_event: ["in_app", "telegram", "native_push"],
} satisfies Record<string, string[]>;

function allowedFor(cls: string): string[] {
  return Object.entries(POLICY).find(([key]) => key === cls)?.[1] ?? ["in_app"];
}

const CONFIGURED = ["in_app", "telegram", "native_push"];
const BINDS = new Set(["telegram", "slack"]);

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function plan(cls: string, pref: Pref, bound: Set<string>) {
  const allowed = allowedFor(cls);
  const steps: BoundaryValue[] = [];
  const excluded: BoundaryValue[] = [];
  for (const kind of pref.channels) {
    if (kind === "in_app") continue;
    if (!allowed.includes(kind)) {
      excluded.push({ kind, reason: "not_allowed_by_policy" });
    } else if (!CONFIGURED.includes(kind)) {
      excluded.push({ kind, reason: "adapter_unavailable" });
    } else if (BINDS.has(kind) && !bound.has(kind)) {
      excluded.push({ kind, reason: "no_active_binding" });
    } else {
      steps.push({ kind, mode: "rendezvous", confidentiality: "minimal" });
    }
  }
  for (const kind of allowed) {
    if (kind !== "in_app" && !pref.channels.includes(kind)) {
      excluded.push({ kind, reason: "not_preferred" });
    }
  }
  steps.push({ kind: "in_app", mode: "interactive", confidentiality: "full" });
  return { steps, fanOut: pref.fanOut, excluded };
}

export function routingServer() {
  const byClass = new Map<string, Pref>([
    [
      "authorization_request",
      { channels: ["telegram", "in_app"], fanOut: false },
    ],
    // Listed before policy tightened: it finds nothing to select.
    [
      "authorization_decision",
      { channels: ["native_push", "in_app"], fanOut: false },
    ],
  ]);
  const wire = () => ({ byClass: Object.fromEntries(byClass) });
  let bindings = [
    {
      id: "bind_1",
      kind: "telegram",
      displayLabel: "Personal phone",
      state: "active",
      providerSubjectId: "tg-77771111",
    },
  ];
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const url = new URL(path, "https://id.example");
    const at = `${method} ${url.pathname}`;
    if (at === "GET /v1/notification-channels") {
      return json({
        channels: ["in_app", "telegram", "slack", "native_push"].map(
          (kind) => ({ kind, configured: CONFIGURED.includes(kind) }),
        ),
      });
    }
    if (at === "GET /v1/notification-channels/bindings") {
      return json({ bindings });
    }
    if (at === "POST /v1/notification-channels/bindings") {
      return json(
        { challengeId: "chbc_1", nonce: "n0nce-once", expiresAt: "x" },
        201,
      );
    }
    if (method === "DELETE") {
      const id = url.pathname.split("/").at(-1);
      bindings = bindings.filter((row) => row.id !== id);
      return new Response(null, { status: 204 });
    }
    if (at === "GET /v1/notification-preferences") return json(wire());
    if (at === "PUT /v1/notification-preferences") {
      const body = JSON.parse(String(init.body));
      byClass.clear();
      for (const [cls, pref] of Object.entries(body.byClass)) {
        byClass.set(cls, overlapCast(pref));
      }
      return json(wire());
    }
    if (at === "GET /v1/notification-preferences/effective") {
      const cls = url.searchParams.get("class") ?? "";
      const bound = new Set(
        bindings.filter((row) => row.state === "active").map((r) => r.kind),
      );
      return json(
        plan(
          cls,
          byClass.get(cls) ?? { channels: ["in_app"], fanOut: false },
          bound,
        ),
      );
    }
    return json({ error: "not_found" }, 404);
  });
  const transport: RoutingTransport = { fetch, signedIn: () => true };
  return {
    fetch,
    transport,
    byClass,
    writes: () =>
      fetch.mock.calls
        .filter(([, init]) => (init.method ?? "GET") !== "GET")
        .map(([path, init]) => `${init.method} ${path}`),
  };
}
