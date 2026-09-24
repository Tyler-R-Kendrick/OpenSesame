/**
 * A claim ceremony wired to a scripted Identity API and an in-memory stash,
 * for the ceremony suites. Each route is a `vi.fn` the test scripts; the
 * transport routes by path exactly as the server does.
 */
import { type StashStorage, createClaimStash } from "@opensesame/ceremony-kit";
import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { vi } from "vitest";
import { createClaimCeremony } from "./ceremony.js";
import type { ClaimTransport } from "./transport.js";

export const OPEN_CLAIM = {
  id: "clm_1",
  type: "agent",
  state: "presented",
  targetManifestDigest: "sha256:abc",
  items: [{ id: "item-1" }, { id: "item-2" }],
};

export const TOKEN = "osc_clm_x.secret";

export function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Route = (...args: string[]) => Promise<Response>;

export function claimHarness() {
  const store = new Map<string, string>();
  const storage: StashStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
  const stash = createClaimStash(() => storage);
  let principal: string | null = "prn_1";
  const routes = {
    /** Called with the presented token. */
    present: vi.fn<Route>(),
    /** Called with the claim id and the `x-claim-token` header. */
    read: vi.fn<Route>(),
    /** Called with the claim id and the body's JSON. */
    complete: vi.fn<Route>(),
    provisional: vi.fn(async () => "prn_guest"),
  };
  const transport: ClaimTransport = {
    async fetch(path, init) {
      const body: JsonObject = init.body
        ? overlapCast(JSON.parse(String(init.body)))
        : {};
      if (path === "/v1/claims/present") {
        return routes.present(String(body.token));
      }
      const id = decodeURIComponent(path.split("/")[3] ?? "");
      if (path.endsWith("/complete")) {
        return routes.complete(id, JSON.stringify(body));
      }
      const token = new Headers(init.headers).get("x-claim-token") ?? "";
      return routes.read(id, token);
    },
    principal: () => principal,
    async provisional() {
      principal = await routes.provisional();
      return principal;
    },
  };
  return {
    ceremony: createClaimCeremony({ transport, stash }),
    routes,
    signIn(next: string | null) {
      principal = next;
    },
    seed(value: BoundaryValue) {
      store.set("opensesame.claim", JSON.stringify(value));
    },
    stashed(): JsonObject | null {
      const raw = store.get("opensesame.claim");
      return raw ? overlapCast(JSON.parse(raw)) : null;
    },
  };
}
