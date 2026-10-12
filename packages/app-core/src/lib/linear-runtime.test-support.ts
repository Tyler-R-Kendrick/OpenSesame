import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { afterEach, beforeEach, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { initialDraftState } from "./connect-draft.js";
import { connectPlan } from "./connect-plan.js";
import { readDeviceSecrets } from "./device-connector-records.js";
import * as kv from "./kv.js";
import { linearApiSeams } from "./linear-api.js";
import { PendingLinearSchema } from "./linear-store.js";
import type { SelfHostedConnectorOptions } from "./self-hosted-connectors.js";

export const linearAccount = {
  viewer: { id: "user-1", name: "Casey", email: "casey@example.org" },
  organization: { id: "workspace-1", name: "Acme", urlKey: "acme" },
  teams: { nodes: [{ id: "team-1", name: "Engineering", key: "ENG" }] },
};
export const linearToken = {
  access_token: "private-access",
  refresh_token: "private-refresh",
  token_type: "Bearer",
  expires_in: 86400,
  scope: "read write issues:create",
};
export const linearOptions: SelfHostedConnectorOptions = {
  mode: "byo",
  workspace: "acme",
  appScopes: ["read"],
  userScopes: [],
  webhookResourceTypes: [],
  icon: "",
};
export const navigate = vi.fn();
export const replaceAddress = vi.fn();

export function linearDraft(method: "oauth" | "api-key" = "api-key") {
  const plan = connectPlan("linear");
  if (!plan) throw new Error("Linear plan missing");
  const draft = initialDraftState(plan, method);
  return {
    ...draft,
    name: "Acme Linear",
    key: method === "api-key" ? "private-api-key" : "",
    oauth: { ...draft.oauth, clientId: "client-1", clientSecret: "" },
  };
}

export function pendingLinear(id: string) {
  return PendingLinearSchema.parse(
    JSON.parse(readDeviceSecrets()[id]?.linear_pending ?? "null"),
  );
}

export function linearAnswers(
  ...answers: { body: BoundaryValue; status?: number }[]
) {
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) => {
      const next = answers.shift();
      if (!next) throw new Error("No Linear response remaining");
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  linearApiSeams.fetch = fetcher;
  return fetcher;
}

/** A stateful provider fixture executes the actual webhook GraphQL requests. */
function graphqlFixtureRequest(init?: RequestInit) {
  const packed: BoundaryValue = JSON.parse(String(init?.body));
  if (
    !isJsonObject(packed) ||
    !isString(packed.query) ||
    !isJsonObject(packed.variables)
  )
    throw new Error("Invalid GraphQL fixture request");
  return { query: packed.query, variables: packed.variables };
}
export function installLinearProvider() {
  type Hook = {
    id: string;
    enabled: boolean;
    url: string;
    label: string | null;
    resourceTypes: string[];
  };
  const hooks = new Map<string, Hook>();
  const created: string[] = [];
  const deleted: string[] = [];
  const fixture = {
    hooks,
    created,
    deleted,
    loseCreateReply: false,
    loseDeleteReply: false,
    onCreate: () => {},
    onDelete: () => {},
  };
  linearApiSeams.fetch = vi.fn(async (url, init) => {
    if (String(url) !== "https://api.linear.app/graphql")
      throw new Error("Unexpected Linear endpoint");
    const { query, variables } = graphqlFixtureRequest(init);
    let data: BoundaryValue;
    if (query.includes("OpenSesameAccount")) data = linearAccount;
    else if (query.includes("OpenSesameDeleteWebhook")) {
      const id = variables.id;
      if (!isString(id)) throw new Error("Webhook ID missing");
      hooks.delete(id);
      deleted.push(id);
      fixture.onDelete();
      if (fixture.loseDeleteReply) {
        fixture.loseDeleteReply = false;
        throw new Error("Lost delete response");
      }
      data = { webhookDelete: { success: true } };
    } else if (query.includes("OpenSesameWebhooks"))
      data = {
        webhooks: {
          nodes: [...hooks.values()],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    else if (query.includes("OpenSesameWebhook")) {
      const input = variables.input;
      if (
        !isJsonObject(input) ||
        !isString(input.id) ||
        !isString(input.url) ||
        !Array.isArray(input.resourceTypes)
      )
        throw new Error("Webhook input missing");
      const resourceTypes = input.resourceTypes.filter(isString);
      const hook = {
        id: input.id,
        enabled: true,
        url: input.url,
        label: isString(input.label) ? input.label : null,
        resourceTypes,
      };
      hooks.set(input.id, hook);
      created.push(input.id);
      fixture.onCreate();
      if (fixture.loseCreateReply) {
        fixture.loseCreateReply = false;
        throw new Error("Lost create response");
      }
      data = {
        webhookCreate: {
          success: true,
          webhook: { id: hook.id, enabled: true },
        },
      };
    } else throw new Error("Unhandled Linear GraphQL query");
    return new Response(JSON.stringify({ data }), {
      headers: { "content-type": "application/json" },
    });
  });
  return fixture;
}

export function installLinearRuntimeTests(): void {
  const inactiveFetch = linearApiSeams.fetch;
  beforeEach(() => {
    kv.kvForgetAll();
    navigate.mockReset();
    replaceAddress.mockReset();
    const memory = new Map<string, string>();
    vi.spyOn(kv.kvSeams, "kvGet").mockImplementation(
      (key) => memory.get(key) ?? null,
    );
    vi.spyOn(kv.kvSeams, "kvSetDurable").mockImplementation(
      async (key, value) => {
        memory.set(key, value);
      },
    );
    vi.spyOn(kv, "kvDurability").mockReturnValue("persistent");
    vi.spyOn(kv, "kvRefresh").mockResolvedValue(undefined);
    configureHost(
      createTestHost({
        env: { BASE_URL: "/OpenSesame/" },
        // This fixture implements the two-argument overload the connector store calls.
        locks: overlapCast(webLocksDouble()),
        page: overlapCast({
          location: {
            origin: "https://app.example.org",
            href: "https://app.example.org/OpenSesame/",
            assign: navigate,
          },
          replaceUrl: replaceAddress,
        }),
      }),
    );
  });
  afterEach(() => {
    linearApiSeams.fetch = inactiveFetch;
    vi.restoreAllMocks();
    configureHost(createTestHost());
  });
}
