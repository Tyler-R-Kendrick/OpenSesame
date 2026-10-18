import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseArgs } from "./parse.js";
import { runCli } from "./run.js";
const RECEIVER = [
  "--receiver",
  "http://127.0.0.1:43127",
  "--service-id",
  "local-canary",
  "--origin",
  "https://vault.example",
  "--port",
  "43127",
];
afterEach(() => vi.restoreAllMocks());
it("requires explicit owner consent for an inert artifact", () => {
  const args = [
    "vault",
    "canary",
    "enroll",
    ...RECEIVER,
    "--label",
    "Work",
    "--artifact-kind",
    "mcp-config",
  ];
  expect(() => parseArgs(args)).toThrow("--owner-consent");
  expect(parseArgs([...args, "--owner-consent"])).toMatchObject({
    name: "vault-canary",
    command: { action: { kind: "enroll", ownerConsent: true } },
  });
});
it("writes the exact public pairing as a new private file after fresh owner authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "opensesame-cli-canary-"));
  const out = join(root, "pairing.json");
  const result = {
    kind: "pairing" as const,
    pairing: {
      v: 1 as const,
      endpoint: RECEIVER[1] ?? "",
      serviceId: "local-canary",
      bindPort: 43127,
      origin: "https://vault.example",
      ownerKeyId: "owner",
      ownerPublicJwk: {
        kty: "EC" as const,
        crv: "P-256" as const,
        x: "public-x",
        y: "public-y",
      },
    },
  };
  const beginCanary = vi.fn(async () => ({
    kind: "complete" as const,
    result,
  }));
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  try {
    const code = await runCli(
      ["vault", "canary", "pairing", ...RECEIVER, "--out", out],
      {
        readPassword: async () => "fresh-current-password",
        canarySecurity: {
          beginCanary,
          isCanaryResultCurrent: (value) => value === result,
        },
      },
    );
    expect(code).toBe(0);
    expect(beginCanary).toHaveBeenCalledWith(
      { kind: "password", secret: "fresh-current-password" },
      expect.objectContaining({ action: { kind: "pairing" } }),
    );
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual(result.pairing);
    if (process.platform !== "win32")
      expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(stdout.mock.calls.flat().join("")).not.toContain(
      "fresh-current-password",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
