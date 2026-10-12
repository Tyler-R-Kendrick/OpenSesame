import { hostname } from "node:os";
import type { ConnectionPort } from "@opensesame/app-core/lib/live/connection-port.js";
/**
 * `opensesame-id session … list|invoke` end to end: a real hosted session in
 * this process (pairing, sealed seat channel, device broker), the CLI as the
 * device through `runCli`, and the test as the person at the owner's tab —
 * comparing the code, picking connections, pressing allow or refuse. Only the
 * network is faked.
 */
import { approveAs } from "@opensesame/app-core/lib/live/device-approval.test-support.js";
import { settle } from "@opensesame/app-core/lib/live/live-clock.fixture.js";
import { FakeBus } from "@opensesame/app-core/lib/live/live-fakes.js";
import { endHosting } from "@opensesame/app-core/lib/live/session.js";
import { describe, expect, it, vi } from "vitest";
import {
  GITHUB,
  LINEAR,
  VAULT_SECRET,
  execute,
  host,
  linkOf,
  pendingRequest,
  useSessionWorld,
} from "./session-hosted.test-support.js";

const world = useSessionWorld();

/** Run a command against a fresh owner that allows `connections`. */
async function approved(
  argv: (link: string) => string[],
  connections: string[] = ["c-github"],
) {
  const bus = new FakeBus();
  const owner = await host(bus);
  const running = execute(world, argv(linkOf(owner)), {
    sessionCarriers: bus.factory(),
  });
  const pending = await pendingRequest(owner);
  expect(
    await approveAs(owner.devices, pending.id, { connections, minutes: 15 }),
  ).toBe("approved");
  return { owner, pending, bus, ran: await running };
}

describe("session list", () => {
  it("shows the code to compare, then the connections the owner picked", async () => {
    world.bind();
    const { owner, pending, ran } = await approved((link) => [
      "session",
      link,
      "list",
      "--connection",
      "c-github",
      "--name",
      "build box",
    ]);
    expect(pending.want).toEqual(["c-github"]);
    expect(ran.code).toBe(0);
    // The code the person at the terminal compares is the one the owner sees.
    expect(ran.err).toContain(
      `Allow it in the host's Live session panel. Check that the code matches: ${pending.userCode}`,
    );
    expect(ran.err).toContain("Asking the host to let this device in");
    expect(ran.out).toMatch(
      /^c-github {2}GitHub \(work\) {2}github {2}provider\.read, provider\.repositories\.read\n$/,
    );
    // Only the connection the owner picked, and nothing on stdout but data.
    expect(ran.out).not.toContain("c-linear");
    expect(ran.out).not.toContain(pending.userCode);
    // The seat left: the owner's tab drops the device and its grant.
    await settle();
    expect(owner.state.devices.grants).toEqual([]);
  });

  it("is named for the machine unless told otherwise", async () => {
    world.bind();
    const bus = new FakeBus();
    const owner = await host(bus);
    const running = execute(world, ["session", linkOf(owner), "list"], {
      sessionCarriers: bus.factory(),
    });
    const pending = await pendingRequest(owner);
    expect(owner.state.guests[0]).toMatchObject({
      kind: "device",
      name: `opensesame-id on ${hostname()}`.slice(0, 64).trim(),
    });
    await approveAs(owner.devices, pending.id, {
      connections: ["c-github"],
      minutes: 5,
    });
    expect((await running).code).toBe(0);
  });

  it("prints one JSON document with --json, and the code still goes to stderr", async () => {
    world.bind();
    const { pending, ran } = await approved(
      (link) => ["session", link, "list", "--json"],
      ["c-github", "c-linear"],
    );
    expect(ran.code).toBe(0);
    const doc = JSON.parse(ran.out);
    expect(doc).toEqual({
      ok: true,
      action: "list",
      expiresAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
      connections: [GITHUB, LINEAR],
    });
    expect(ran.err).toContain(pending.userCode);
    expect(ran.out).not.toContain(pending.userCode);
  });

  it("reads the link and the invite code from the environment", async () => {
    world.bind();
    const bus = new FakeBus();
    const owner = await host(bus, { admission: "invite" });
    vi.stubEnv("OPENSESAME_LIVE_LINK", linkOf(owner));
    vi.stubEnv("OPENSESAME_LIVE_CODE", owner.code ?? "");
    try {
      const running = execute(world, ["session", "list"], {
        sessionCarriers: bus.factory(),
      });
      const pending = await pendingRequest(owner);
      await approveAs(owner.devices, pending.id, {
        connections: ["c-github"],
        minutes: 5,
      });
      const ran = await running;
      expect(ran.code).toBe(0);
      expect(ran.out).toContain("c-github");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("session invoke", () => {
  it("makes the call through the owner's tab and prints what it reported", async () => {
    const invoke = vi.fn<ConnectionPort["invoke"]>(async () => ({
      label: "Repositories",
      items: [
        { id: "acme/api", label: "acme/api", url: "https://x.test/acme/api" },
        { id: "acme/web", label: "acme/web" },
      ],
    }));
    world.bind(invoke);
    const { pending, ran } = await approved((link) => [
      "session",
      link,
      "invoke",
      "c-github",
      "provider.repositories.read",
      "--input",
      "org=acme",
    ]);
    // The connection being used is suggested to the owner, never granted by it.
    expect(pending.want).toEqual(["c-github"]);
    expect(ran.code).toBe(0);
    expect(ran.out).toBe(
      "Repositories\nacme/api  acme/api  https://x.test/acme/api\nacme/web  acme/web\n",
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      connection: "c-github",
      operation: "provider.repositories.read",
      input: { org: "acme" },
    });
  });

  it("prints one JSON document with --json", async () => {
    world.bind();
    const { ran } = await approved((link) => [
      "session",
      link,
      "invoke",
      "c-github",
      "provider.read",
      "--json",
    ]);
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.out)).toEqual({
      ok: true,
      action: "invoke",
      connection: "c-github",
      operation: "provider.read",
      label: "Repositories",
      items: [
        { id: "acme/api", label: "acme/api", url: "https://x.test/acme/api" },
      ],
      truncated: false,
    });
  });

  it("says so when the owner's tab cut the answer short", async () => {
    world.bind(async () => ({
      label: "Everything",
      items: Array.from({ length: 150 }, (_, at) => ({
        id: `item-${at}`,
        label: `Item ${at}`,
      })),
    }));
    const { ran } = await approved((link) => [
      "session",
      link,
      "invoke",
      "c-github",
      "provider.read",
    ]);
    expect(ran.code).toBe(0);
    expect(ran.err).toContain("cut this answer short");
    expect(ran.out.trim().split("\n")).toHaveLength(101);
  });

  it("does not ask the host for a connection the grant leaves out", async () => {
    const invoke = vi.fn<ConnectionPort["invoke"]>();
    world.bind(invoke);
    const { ran } = await approved(
      (link) => ["session", link, "invoke", "c-github", "provider.read"],
      ["c-linear"],
    );
    expect(ran.code).toBe(1);
    expect(ran.out).toBe("");
    expect(ran.err).toContain("The host did not allow that");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("tells an operation the connection does not list from the rest", async () => {
    world.bind();
    const { ran } = await approved((link) => [
      "session",
      link,
      "invoke",
      "c-github",
      "provider.objects.read",
    ]);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("does not support this operation");
  });

  it("reports a failing provider as a code, never as what the provider said", async () => {
    world.bind(async () => {
      throw new Error("401 token ghp_SECRET for https://x.test/?key=abc");
    });
    const { ran } = await approved((link) => [
      "session",
      link,
      "invoke",
      "c-github",
      "provider.read",
    ]);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("The provider answered with an error.");
    expect(ran.out + ran.err).not.toContain("ghp_SECRET");
  });

  it("says the session ended when the owner ends it mid-call", async () => {
    world.bind(() => new Promise(() => undefined));
    const bus = new FakeBus();
    const owner = await host(bus);
    const running = execute(
      world,
      ["session", linkOf(owner), "invoke", "c-github", "provider.read"],
      { sessionCarriers: bus.factory() },
    );
    const pending = await pendingRequest(owner);
    await approveAs(owner.devices, pending.id, {
      connections: ["c-github"],
      minutes: 5,
    });
    await settle(20);
    endHosting();
    const ran = await running;
    expect(ran.code).toBe(1);
    expect(ran.err).toMatch(/session ended|host has ended/);
  });
});

describe("what a relay and a log can see of it", () => {
  it("never prints the link, the code or the owner's vault", async () => {
    world.bind();
    const bus = new FakeBus();
    const owner = await host(bus, { admission: "invite" });
    const code = owner.code ?? "";
    expect(code).not.toBe("");
    const link = linkOf(owner);
    const outputs: string[] = [];
    for (const argv of [
      ["session", link, "list", "--code", code],
      [
        "session",
        link,
        "invoke",
        "c-github",
        "provider.read",
        "--json",
        "--code",
        code,
      ],
    ]) {
      const running = execute(world, argv, { sessionCarriers: bus.factory() });
      const pending = await pendingRequest(owner);
      await approveAs(owner.devices, pending.id, {
        connections: ["c-github"],
        minutes: 5,
      });
      const ran = await running;
      expect(ran.code).toBe(0);
      outputs.push(ran.out, ran.err);
      await settle();
    }
    const everything = outputs.join("\n");
    for (const word of [
      owner.link.secret,
      owner.link.owner,
      code,
      VAULT_SECRET,
      "live=v1",
    ])
      expect(everything).not.toContain(word);
    // The device code is 22 base64url characters; nothing printed looks like one.
    expect(everything).not.toMatch(/[A-Za-z0-9_-]{22}/);
  });
});
