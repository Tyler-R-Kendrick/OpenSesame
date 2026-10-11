/** @vitest-environment jsdom */
/**
 * A quorum-approved standing share, against a real vault tomb and the existing
 * share ledger: what the guardians approved is what gets written, once, for a
 * person, and only after the quorum and the delay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLocalDirectory } from "../local-directory.js";
import { localRequestFixture } from "../local-request.fixture.js";
import { type LocalShare, listLocalShares } from "../local-share-grants.js";
import { lockAllTombs } from "../vfs.js";
import { buildApproval } from "./approve.js";
import { toB64url } from "./bytes.js";
import {
  QuorumGrantError,
  assertGrantWritable,
  grantFromQuorum,
} from "./grant.js";
import { generateKeyPair } from "./hpke.js";
import { QuorumLedger } from "./ledger.js";
import { createRequest } from "./request.js";
import type { Grant, QuorumRequest } from "./types.js";
import { T0, type World, buildWorld, person } from "./world.test-support.js";

beforeEach(() => {
  // The share-ledger tests run jsdom with Node's typed arrays; so do these.
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
});

afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NAMES = ["Ada", "Ben", "Cy"];

function grantOf(request: QuorumRequest): Grant {
  if (!request.grant) throw new Error("the request carries no grant");
  return request.grant;
}

function clock() {
  const state = { t: T0.getTime() };
  return {
    now: () => state.t,
    date: () => new Date(state.t),
    at: (seconds: number) => {
      state.t = T0.getTime() + seconds * 1000;
    },
  };
}

async function setup(overrides: Partial<Grant> = {}) {
  const fixture = await localRequestFixture();
  const world = await buildWorld({
    names: NAMES,
    groups: [{ id: "g", threshold: 2, members: NAMES }],
    operations: ["grant-access"],
  });
  const grant: Grant = {
    principalId: fixture.personId,
    resourceKind: "item",
    resourceId: "bank-login",
    resourceLabel: "Bank login",
    policy: "read",
    durationSeconds: 3600,
    ...overrides,
  };
  const c = clock();
  const request = createRequest({
    signedPolicy: world.created.signedPolicy,
    operation: "grant-access",
    grant,
    recipientPublicKey: toB64url(generateKeyPair().publicKey),
    recipientLabel: "unused for a grant",
    now: c.date(),
  });
  const ledger = QuorumLedger.open(world.created.signedPolicy, request, c.now);
  return { fixture, world, grant, c, request, ledger };
}

async function approveBy(
  world: World,
  ledger: QuorumLedger,
  who: string[],
  c: ReturnType<typeof clock>,
) {
  for (const name of who) {
    const p = person(world, name);
    const outcome = await ledger.submitApproval(
      await buildApproval({
        seat: { signedPolicy: world.created.signedPolicy, guardianId: p.id },
        request: ledger.request,
        ceremony: p.ceremony,
        now: c.date(),
      }),
    );
    expect(outcome).toEqual({ ok: true });
  }
}

async function refusal(promise: Promise<LocalShare[]>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof QuorumGrantError) return error.code;
    throw error;
  }
  return "granted";
}

describe("a quorum-approved standing share", () => {
  it("writes exactly the approved share once the quorum has approved and the delay has passed", async () => {
    const { fixture, world, grant, c, ledger } = await setup();
    await approveBy(world, ledger, ["Ada", "Cy"], c);
    c.at(3601);
    const shares = await grantFromQuorum({
      tomb: fixture.tomb,
      ledger,
      now: c.now(),
    });
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({
      principalId: grant.principalId,
      resourceKind: "item",
      resourceId: "bank-login",
      resourceLabel: "Bank login",
      policy: "read",
    });
    // The ordinary Access list sees it, as it sees any share.
    expect(await listLocalShares(fixture.tomb)).toHaveLength(1);
    expect(ledger.status().state).toBe("executed");
  });

  it("states the grant in the sentence the guardians approve", async () => {
    const { request, grant } = await setup();
    expect(request.summary).toContain(
      `Let ${grant.principalId} read the item "Bank login" for 1 hour(s)`,
    );
  });

  it("writes nothing before a quorum, or before the delay", async () => {
    const { fixture, world, c, ledger } = await setup();
    await approveBy(world, ledger, ["Ada"], c);
    c.at(3601);
    expect(
      await refusal(
        grantFromQuorum({ tomb: fixture.tomb, ledger, now: c.now() }),
      ),
    ).toBe("not_authorized");

    const second = await setup();
    await approveBy(second.world, second.ledger, ["Ada", "Ben"], second.c);
    second.c.at(1800);
    expect(
      await refusal(
        grantFromQuorum({
          tomb: second.fixture.tomb,
          ledger: second.ledger,
          now: second.c.now(),
        }),
      ),
    ).toBe("not_authorized");
    expect(await listLocalShares(second.fixture.tomb)).toHaveLength(0);
  });

  it("writes once: the approval is spent", async () => {
    const { fixture, world, c, ledger } = await setup();
    await approveBy(world, ledger, ["Ben", "Cy"], c);
    c.at(3601);
    await grantFromQuorum({ tomb: fixture.tomb, ledger, now: c.now() });
    expect(
      await refusal(
        grantFromQuorum({ tomb: fixture.tomb, ledger, now: c.now() }),
      ),
    ).toBe("not_authorized");
    expect(await listLocalShares(fixture.tomb)).toHaveLength(1);
  });

  it("refuses a grant the share ledger would not write, before anything is spent", async () => {
    // "open" is a vault policy; an item allows read or use.
    const { fixture, world, c, ledger } = await setup({ policy: "open" });
    expect(() => assertGrantWritable(grantOf(ledger.request))).toThrow(
      QuorumGrantError,
    );
    await approveBy(world, ledger, ["Ada", "Ben"], c);
    c.at(3601);
    expect(
      await refusal(
        grantFromQuorum({ tomb: fixture.tomb, ledger, now: c.now() }),
      ),
    ).toBe("invalid_grant");
    // Nothing was claimed, so the ledger still stands authorized.
    expect(ledger.status().state).toBe("authorized");
    expect(await listLocalShares(fixture.tomb)).toHaveLength(0);
  });

  it("refuses a lapsed or cancelled request", async () => {
    const { fixture, world, c, ledger } = await setup();
    await approveBy(world, ledger, ["Ada", "Ben"], c);
    c.at(86401 + 10);
    expect(
      await refusal(
        grantFromQuorum({ tomb: fixture.tomb, ledger, now: c.now() }),
      ),
    ).toBe("not_authorized");
  });

  it("will not grant an agent or an application: those need the owner's own approval", async () => {
    const fixture = await localRequestFixture();
    await fixture.change({ action: "create", kind: "agent", name: "Helper" });
    const directory = await readLocalDirectory(fixture.tomb);
    const agent = directory.entries.find((e) => e.kind === "agent");
    if (!agent) throw new Error("no agent");
    const world = await buildWorld({
      names: NAMES,
      groups: [{ id: "g", threshold: 2, members: NAMES }],
      operations: ["grant-access"],
    });
    const c = clock();
    const request = createRequest({
      signedPolicy: world.created.signedPolicy,
      operation: "grant-access",
      grant: {
        principalId: agent.id,
        resourceKind: "item",
        resourceId: "bank-login",
        resourceLabel: "Bank login",
        policy: "read",
        durationSeconds: 3600,
      },
      recipientPublicKey: toB64url(generateKeyPair().publicKey),
      recipientLabel: "x",
      now: c.date(),
    });
    const ledger = QuorumLedger.open(
      world.created.signedPolicy,
      request,
      c.now,
    );
    await approveBy(world, ledger, ["Ada", "Cy"], c);
    c.at(3601);
    expect(
      await refusal(
        grantFromQuorum({ tomb: fixture.tomb, ledger, now: c.now() }),
      ),
    ).toBe("principal");
    expect(await listLocalShares(fixture.tomb)).toHaveLength(0);
  });

  it("refuses a duration the share ledger does not write", async () => {
    const { fixture, world, c, ledger } = await setup({
      durationSeconds: 5000,
    });
    await approveBy(world, ledger, ["Ada", "Cy"], c);
    c.at(3601);
    expect(
      await refusal(
        grantFromQuorum({ tomb: fixture.tomb, ledger, now: c.now() }),
      ),
    ).toBe("invalid_grant");
  });

  it("refuses a request that carries no grant, and a grant on any other operation", async () => {
    const world = await buildWorld({
      names: NAMES,
      groups: [{ id: "g", threshold: 2, members: NAMES }],
      operations: ["grant-access", "export-items"],
    });
    const key = toB64url(generateKeyPair().publicKey);
    expect(() =>
      createRequest({
        signedPolicy: world.created.signedPolicy,
        operation: "grant-access",
        recipientPublicKey: key,
        recipientLabel: "x",
        now: T0,
      }),
    ).toThrow(/grant belongs/);
    expect(() =>
      createRequest({
        signedPolicy: world.created.signedPolicy,
        operation: "export-items",
        grant: {
          principalId: "p",
          resourceKind: "item",
          resourceId: "x",
          resourceLabel: "x",
          policy: "read",
          durationSeconds: 3600,
        },
        recipientPublicKey: key,
        recipientLabel: "x",
        now: T0,
      }),
    ).toThrow(/grant belongs/);
  });

  it("does not open a ledger for a request whose grant was edited after the sentence was written", async () => {
    const { world, request, c } = await setup();
    const widened = {
      ...request,
      grant: {
        ...grantOf(request),
        resourceKind: "vault" as const,
        policy: "open",
      },
    };
    expect(() =>
      QuorumLedger.open(world.created.signedPolicy, widened, c.now),
    ).toThrow(/sentence/);
  });
});
