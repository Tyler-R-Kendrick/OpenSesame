import type { BoundaryValue } from "@opensesame/os-domain";
import { bytesToB64url } from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EgressPort } from "../capabilities/runtime-contract.js";
import { tailnetAdmin, tailnetAdminSeams } from "./client.js";
import { TailnetAdminError, tailnetErrorText } from "./errors.js";
import {
  TAILNET_PAIRING_PREFIX,
  type TailnetAdminPairing,
  parseTailnetAdminPairing,
  parseTailnetPairingCode,
} from "./pairing.js";

const ORIGIN = "https://ops.example.com";
const SECRET = "c".repeat(43);
const TOKEN = "t".repeat(43);
/** Fields of a printed code, any of them replaced — even with what no CLI prints. */
type CodeFields = Readonly<{
  url?: string;
  code?: string;
  origin?: string;
  role?: string;
  label?: string;
}>;

/** A printed code. */
const code = (overrides: CodeFields = {}) => {
  const fields = {
    url: "https://desk.tail4c2e.ts.net",
    code: SECRET,
    origin: ORIGIN,
    role: "manage",
    label: "Ops laptop",
    ...overrides,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(fields));
  return `${TAILNET_PAIRING_PREFIX}${bytesToB64url(bytes)}`;
};
const original = { ...tailnetAdminSeams };
afterEach(() => Object.assign(tailnetAdminSeams, original));

function egress(answer: () => Response): EgressPort & { calls: number } {
  const port = {
    calls: 0,
    async fetch() {
      port.calls += 1;
      return answer();
    },
  };
  return port;
}

function pairable(kept: TailnetAdminPairing[] = []) {
  tailnetAdminSeams.pageOrigin = () => ORIGIN;
  tailnetAdminSeams.vaultReady = () => true;
  tailnetAdminSeams.eligible = () => true;
  tailnetAdminSeams.bind = () => ({ tomb: "personal", revision: 1 });
  tailnetAdminSeams.keep = async (next) => {
    kept.push(next);
  };
  return kept;
}

const json = (status: number, body: BoundaryValue) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("pairing", () => {
  it("trades a code once and seals the bearer with its role", async () => {
    const kept = pairable();
    const port = egress(() =>
      json(201, {
        id: "tp_1",
        origin: ORIGIN,
        role: "read",
        label: "x",
        token: TOKEN,
      }),
    );
    await tailnetAdmin(port, "networking.tailnet-devices").pair(code());
    expect(kept).toEqual([
      {
        url: "https://desk.tail4c2e.ts.net",
        token: TOKEN,
        origin: ORIGIN,
        role: "read",
        label: "Ops laptop",
      },
    ]);
  });

  it("pairing again revokes the bearer it replaced, at the daemon that held it", async () => {
    const kept = pairable();
    const OLD = "o".repeat(43);
    tailnetAdminSeams.pairing = () => ({
      url: "https://old.tail4c2e.ts.net",
      token: OLD,
      origin: ORIGIN,
      role: "manage",
      label: "Old laptop",
    });
    const sent: Array<{ url: string; method: string; auth: string }> = [];
    const port: EgressPort = {
      async fetch(input, init) {
        sent.push({
          url: String(input),
          method: init?.method ?? "GET",
          auth: new Headers(init?.headers).get("Authorization") ?? "",
        });
        return init?.method === "DELETE"
          ? new Response(null, { status: 204 })
          : json(201, { origin: ORIGIN, role: "read", token: TOKEN });
      },
    };
    await tailnetAdmin(port, "networking.tailnet-devices").pair(code());
    expect(kept.map((k) => k.token)).toEqual([TOKEN]);
    expect(sent).toEqual([
      {
        url: "https://desk.tail4c2e.ts.net/v1/tailnet/pairing",
        method: "POST",
        auth: "",
      },
      {
        url: "https://old.tail4c2e.ts.net/v1/tailnet/pairing",
        method: "DELETE",
        auth: `Bearer ${OLD}`,
      },
    ]);
  });

  it("refuses before sending anything it cannot use", async () => {
    pairable();
    const port = egress(() => json(201, {}));
    const client = tailnetAdmin(port, "networking.tailnet-devices");
    await expect(client.pair("hello")).rejects.toMatchObject({
      code: "not-a-code",
    });
    await expect(
      client.pair(code({ origin: "https://other.example" })),
    ).rejects.toMatchObject({
      code: "other-origin",
    });
    tailnetAdminSeams.vaultReady = () => false;
    await expect(client.pair(code())).rejects.toMatchObject({ code: "locked" });
    // A shared origin is refused before the vault is even asked.
    tailnetAdminSeams.eligible = () => false;
    await expect(client.pair(code())).rejects.toMatchObject({
      code: "shared-origin",
    });
    expect(port.calls).toBe(0);
  });

  it("refuses an answer that is not a bearer for this origin", async () => {
    const kept = pairable();
    for (const body of [
      { origin: ORIGIN, role: "manage", token: "short" },
      { origin: "https://evil.example", role: "manage", token: TOKEN },
      { origin: ORIGIN, role: "owner", token: TOKEN },
    ]) {
      const client = tailnetAdmin(
        egress(() => json(201, body)),
        "networking.tailnet-devices",
      );
      await expect(client.pair(code())).rejects.toMatchObject({
        code: "malformed",
      });
    }
    const refused = tailnetAdmin(
      egress(() => json(403, { error: "pairing_refused" })),
      "networking.tailnet-devices",
    );
    await expect(refused.pair(code())).rejects.toMatchObject({
      code: "pairing-refused",
    });
    expect(kept).toEqual([]);
  });

  it("a code must name a tailnet or this machine, a pairable origin and a role", () => {
    expect(parseTailnetPairingCode(code())).not.toBeNull();
    expect(
      parseTailnetPairingCode(code({ url: "https://evil.example.com" })),
    ).toBeNull();
    expect(
      parseTailnetPairingCode(code({ origin: "http://ops.example.com" })),
    ).toBeNull();
    expect(parseTailnetPairingCode(code({ role: "owner" }))).toBeNull();
    expect(parseTailnetPairingCode(code({ code: "short" }))).toBeNull();
    expect(
      parseTailnetAdminPairing({
        url: "https://desk.tail4c2e.ts.net",
        token: TOKEN,
        origin: ORIGIN,
        role: "read",
      }),
    ).not.toBeNull();
    expect(
      parseTailnetAdminPairing({
        url: "https://desk.tail4c2e.ts.net",
        token: TOKEN,
        origin: ORIGIN,
      }),
    ).toBeNull();
  });
});

describe("requests", () => {
  it("send nothing with no daemon paired", async () => {
    tailnetAdminSeams.pairing = () => null;
    const port = egress(() => json(200, { devices: [] }));
    await expect(
      tailnetAdmin(port, "networking.tailnet-devices").listDevices(),
    ).rejects.toMatchObject({
      code: "no-daemon",
    });
    expect(port.calls).toBe(0);
  });

  it("say the daemon was unreachable, and refuse an unreadable answer", async () => {
    tailnetAdminSeams.pairing = () => ({
      url: "https://desk.tail4c2e.ts.net",
      token: TOKEN,
      origin: ORIGIN,
      role: "manage",
      label: "",
    });
    const down: EgressPort = {
      fetch: vi.fn(async () => {
        throw new TypeError("failed");
      }),
    };
    await expect(
      tailnetAdmin(down, "networking.tailnet-devices").listDevices(),
    ).rejects.toMatchObject({ code: "unreachable" });
    const garbled = egress(() => new Response("<html>", { status: 502 }));
    await expect(
      tailnetAdmin(garbled, "networking.tailnet-devices").listDevices(),
    ).rejects.toMatchObject({ code: "malformed", status: 502 });
    const notDevices = egress(() => json(200, { nope: true }));
    await expect(
      tailnetAdmin(notDevices, "networking.tailnet-devices").listDevices(),
    ).rejects.toMatchObject({ code: "malformed" });
  });

  it("forget asks the daemon to drop the bearer, then drops it here", async () => {
    tailnetAdminSeams.pairing = () => ({
      url: "https://desk.tail4c2e.ts.net",
      token: TOKEN,
      origin: ORIGIN,
      role: "manage",
      label: "",
    });
    tailnetAdminSeams.revision = () => 7;
    const dropped: number[] = [];
    tailnetAdminSeams.drop = async (revision) => {
      dropped.push(revision);
    };
    const port = egress(() => new Response(null, { status: 204 }));
    await tailnetAdmin(port, "networking.tailnet-devices").forget();
    expect(port.calls).toBe(1);
    expect(dropped).toEqual([7]);
  });
});

it("every refusal has words, Tailscale's added when it gave some", () => {
  expect(tailnetErrorText(new TailnetAdminError("role_forbidden"))).toMatch(
    /read the tailnet but not change/,
  );
  expect(
    tailnetErrorText(
      new TailnetAdminError("tailscale_rejected", 422, "tag:x is invalid"),
    ),
  ).toMatch(/refused the change\. tag:x is invalid$/);
  expect(tailnetErrorText(new TailnetAdminError("something_new"))).toMatch(
    /something_new/,
  );
});
