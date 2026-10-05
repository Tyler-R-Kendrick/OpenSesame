/**
 * The Pages client against `spec/conformance/tailnet-admin-protocol.json`
 * (ADR 0167): every exchange driven through the real client and a fake
 * egress port. The client must build exactly the request the spec records
 * and read exactly the answer the daemon gives — which the daemon is held to
 * by the same file (`crates/daemon/src/tailnet_admin_conformance_tests.rs`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
} from "@opensesame/os-domain";
import { afterEach, describe, expect, it } from "vitest";
import type { EgressPort } from "../capabilities/runtime-contract.js";
import {
  type TailnetAdmin,
  tailnetAdmin,
  tailnetAdminSeams,
} from "./client.js";
import { TailnetAdminError } from "./errors.js";
import {
  formatTailnetPairingCode,
  parseTailnetPairingCode,
} from "./pairing.js";

const here = dirname(fileURLToPath(import.meta.url));
const spec: JsonObject = JSON.parse(
  readFileSync(
    join(here, "../../../../../spec/conformance/tailnet-admin-protocol.json"),
    "utf8",
  ),
);

type Exchange = {
  name: string;
  operation: string;
  request: { method: string; path: string; body: BoundaryValue };
  response: { status: number; body: BoundaryValue };
};
const exchanges: Exchange[] = JSON.parse(JSON.stringify(spec.exchanges));

const BASE = "https://desk.tail4c2e.ts.net";
const TOKEN = "T".repeat(43);
const original = { ...tailnetAdminSeams };

afterEach(() => Object.assign(tailnetAdminSeams, original));

type Sent = { url: string; method: string; body: BoundaryValue; auth: string };

function harness(answer: Exchange["response"]) {
  const sent: Sent[] = [];
  const egress: EgressPort = {
    async fetch(input, init) {
      const headers = new Headers(init?.headers);
      sent.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
        auth: headers.get("Authorization") ?? "",
      });
      return answer.body === null
        ? new Response(null, { status: answer.status })
        : new Response(JSON.stringify(answer.body), {
            status: answer.status,
            headers: { "Content-Type": "application/json" },
          });
    },
  };
  tailnetAdminSeams.pairing = () => ({
    url: BASE,
    token: TOKEN,
    origin: "https://ops.example.com",
    role: "manage",
    label: "Ops laptop",
  });
  return { client: tailnetAdmin(egress, "networking.tailnet-devices"), sent };
}

function idIn(path: string): string {
  const parts = path.split("/");
  return parts[4] ?? "";
}

function field(body: BoundaryValue, name: string): BoundaryValue {
  return isJsonObject(body) ? body[name] : null;
}

/** What a client call hands back: a parsed object or list, or nothing. */
type ClientResult = object | null;

/** The client call an exchange's operation names, with its arguments. */
function invoke(
  client: TailnetAdmin,
  exchange: Exchange,
): Promise<ClientResult> {
  const { path, body } = exchange.request;
  const id = idIn(path);
  const strings = (name: string): string[] => {
    const value = field(body, name);
    return Array.isArray(value) ? value.map(String) : [];
  };
  switch (exchange.operation) {
    case "status":
      return client.status();
    case "listDevices":
      return client.listDevices().then((d) => [...d]);
    case "getDevice":
      return client.getDevice(id);
    case "setAuthorized":
      return client
        .setAuthorized(id, field(body, "authorized") === true)
        .then(() => null);
    case "rename":
      return client.rename(id, String(field(body, "name"))).then(() => null);
    case "setTags":
      return client.setTags(id, strings("tags")).then(() => null);
    case "setKeyExpiryDisabled":
      return client
        .setKeyExpiryDisabled(id, field(body, "disabled") === true)
        .then(() => null);
    case "expire":
      return client.expire(id).then(() => null);
    case "setRoutes":
      return client.setRoutes(id, strings("enabled_routes"));
    case "deleteDevice":
      return client.deleteDevice(id).then(() => null);
    case "listKeys":
      return client.listKeys().then((k) => [...k]);
    case "createKey":
      return client.createKey({
        description: String(field(body, "description")),
        reusable: field(body, "reusable") === true,
        ephemeral: field(body, "ephemeral") === true,
        preauthorized: field(body, "preauthorized") === true,
        tags: strings("tags"),
        expirySeconds: Number(field(body, "expiry_seconds")),
      });
    case "deleteKey":
      return client.deleteKey(id).then(() => null);
    default:
      throw new Error(`no client call for ${exchange.operation}`);
  }
}

/** snake_case keys to the client's camelCase, values unchanged. */
function camel(value: BoundaryValue): BoundaryValue {
  if (Array.isArray(value)) return value.map(camel);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      camel(inner),
    ]),
  );
}

/** What the client should hand back for a successful exchange. */
function expected(exchange: Exchange): BoundaryValue {
  const body = exchange.response.body;
  if (exchange.operation === "listDevices")
    return camel(field(body, "devices"));
  if (exchange.operation === "listKeys") return camel(field(body, "keys"));
  if (exchange.operation === "status") {
    const { connected_at: _, ...rest } = isJsonObject(body) ? body : {};
    return camel(rest);
  }
  return camel(body);
}

describe("the tailnet admin client speaks the spec", () => {
  for (const exchange of exchanges) {
    it(exchange.name, async () => {
      const { client, sent } = harness(exchange.response);
      const outcome = await invoke(client, exchange).then(
        (value) => ({ value }),
        (error: Error) => ({ error }),
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]?.url).toBe(`${BASE}${exchange.request.path}`);
      expect(sent[0]?.method).toBe(exchange.request.method);
      expect(sent[0]?.body).toEqual(exchange.request.body);
      expect(sent[0]?.auth).toBe(`Bearer ${TOKEN}`);
      const { status, body } = exchange.response;
      if (status < 300) {
        expect("value" in outcome && outcome.value).toEqual(expected(exchange));
        return;
      }
      expect("error" in outcome && outcome.error).toBeInstanceOf(
        TailnetAdminError,
      );
      const error = "error" in outcome ? outcome.error : null;
      expect(error instanceof TailnetAdminError && error.code).toBe(
        field(body, "error"),
      );
      expect(error instanceof TailnetAdminError && error.status).toBe(status);
      expect(error instanceof TailnetAdminError && error.detail).toBe(
        field(body, "detail") ?? "",
      );
    });
  }

  it("reads the pairing code the CLI prints, and prints it the same way", () => {
    const pairing = spec.pairing;
    if (!isJsonObject(pairing)) throw new Error("spec has a pairing");
    const parsed = parseTailnetPairingCode(String(pairing.printed));
    expect(parsed).toEqual({
      url: pairing.url,
      code: pairing.code,
      origin: pairing.origin,
      role: pairing.role,
      label: pairing.label,
    });
    expect(parsed && formatTailnetPairingCode(parsed)).toBe(pairing.printed);
  });
});
