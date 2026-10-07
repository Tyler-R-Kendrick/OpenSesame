import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { vi } from "vitest";

export const PUBLIC_VALUE = "public-autofill-background-control-value";
export function daemonWire() {
  const requests: { url: string; init: RequestInit }[] = [];
  const holds: Array<{
    path: string;
    started: ReturnType<typeof deferred<void>>;
    response: ReturnType<typeof deferred<Response>>;
    taken: boolean;
  }> = [];
  let failure: Error | undefined;
  const defaults: Record<string, BoundaryValue> = {
    "/v1/fill/pair": { state: "pending", code: "CURRENT1" },
    "/v1/fill/match": { references: ["Controlled/reference"] },
    "/v1/fill": { field: "password", value: PUBLIC_VALUE },
  };
  const json = (value: BoundaryValue) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!init) throw new Error("Expected actual daemon POST options");
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, init });
      if (failure) {
        const error = failure;
        failure = undefined;
        throw error;
      }
      const path = new URL(url).pathname;
      const held = holds.find((entry) => entry.path === path && !entry.taken);
      if (held) {
        held.taken = true;
        held.started.finish();
        return held.response.promise;
      }
      return json(defaults[path]);
    },
  );
  return {
    requests,
    failNext: () => {
      failure = new Error("Physical transport unavailable");
    },
    hold(path: string) {
      const held = {
        path,
        started: deferred<void>(),
        response: deferred<Response>(),
        taken: false,
      };
      holds.push(held);
      return {
        started: held.started.promise,
        release: (value: BoundaryValue) => held.response.finish(json(value)),
      };
    },
    releaseAll() {
      for (const held of holds) held.response.finish(json({ state: "paired" }));
    },
  };
}
