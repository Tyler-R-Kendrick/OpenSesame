import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  VercelAnonProvider,
  deployAnonymousVercelRelay,
} from "./vercel-anon-relay.js";

function fakeVercelApi() {
  const calls: string[] = [];
  let deploymentBody = "";
  let uploadAuth = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/v1/anonymous/projects"))
      return Response.json({
        token: "anon-token",
        projectId: "prj_test",
        claimUrl: "https://vercel.com/claim-deployment?code=x",
        expiresAt: Date.now() + 3_600_000,
      });
    if (url.includes(".tmp.now"))
      return new Response("unauthorized", { status: 401 });
    if (url.includes("/v2/files")) {
      uploadAuth = String(
        new Headers(init?.headers).get("authorization") ?? "",
      );
      return new Response(null, { status: 200 });
    }
    if (url.includes("/v13/deployments") && init?.method === "POST") {
      deploymentBody = String(init.body ?? "");
      return Response.json({
        id: "dpl_test",
        url: "opensesame-relay-abc.vercel.app",
        alias: ["opensesame-relay-abc-anon.vercel.app"],
      });
    }
    if (url.includes("/v13/deployments/dpl_test"))
      return Response.json({
        id: "dpl_test",
        url: "opensesame-relay-abc.vercel.app",
        alias: ["calm-breeze-123.tmp.now"],
      });
    return Response.json({});
  };
  return {
    fetchImpl,
    calls,
    deploymentBody: () => deploymentBody,
    uploadAuth: () => uploadAuth,
  };
}

function fakeVercelApiNeverReady() {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/v1/anonymous/projects"))
      return Response.json({
        token: "anon-token",
        projectId: "prj_test",
        claimUrl: "https://vercel.com/claim-deployment?code=x",
        expiresAt: Date.now() + 3_600_000,
      });
    if (url.includes("/v2/files")) return new Response(null, { status: 200 });
    if (url.includes("/v13/deployments") && init?.method === "POST")
      return Response.json({
        id: "dpl_stuck",
        url: "opensesame-relay-abc.vercel.app",
        alias: ["opensesame-relay-abc-anon.vercel.app"],
      });
    return Response.json({});
  };
  return { fetchImpl, calls };
}

describe("anonymous Vercel relay deployment", () => {
  it("deletes the deployment when the tmp.now alias never arrives", async () => {
    const fake = fakeVercelApiNeverReady();
    await expect(
      deployAnonymousVercelRelay({
        fetchImpl: fake.fetchImpl,
        readyTimeoutMs: 1,
      }),
    ).rejects.toThrow("tmp.now");
    expect(
      fake.calls.some(
        (c) => c.startsWith("DELETE ") && c.includes("dpl_stuck"),
      ),
    ).toBe(true);
  });

  it("bootstraps an anonymous project and deploys the relay with no claim step", async () => {
    const fake = fakeVercelApi();
    const deployed = await deployAnonymousVercelRelay({
      fetchImpl: fake.fetchImpl,
      readyTimeoutMs: 5_000,
    });
    expect(deployed.relayUrl).toBe("https://calm-breeze-123.tmp.now/api");
    expect(deployed.relayToken.length).toBeGreaterThan(16);
    expect(fake.uploadAuth()).toBe("Bearer anon-token");
    const body = z
      .object({
        files: z.array(z.object({ file: z.string() })),
        env: z.record(z.string(), z.string()),
      })
      .passthrough()
      .parse(JSON.parse(fake.deploymentBody()));
    expect(body.files.map((f) => f.file)).toContain(
      ".vercel/output/functions/api/fetch.func/index.js",
    );
    expect(body.files.map((f) => f.file)).toContain(
      ".vercel/output/config.json",
    );
    expect(body.env.RELAY_TOKEN).toBe(deployed.relayToken);
    await deployed.close();
    expect(
      fake.calls.some(
        (c) => c.startsWith("DELETE ") && c.includes("dpl_test"),
      ),
    ).toBe(true);
  });

  it("provider allocates with provider id vercel and tears down on close", async () => {
    let closed = false;
    const provider = new VercelAnonProvider({
      deployRelay: async () => ({
        relayUrl: "https://relay.example.test/api",
        relayToken: "tok",
        close: async () => {
          closed = true;
        },
      }),
    });
    const sandbox = await provider.allocate({
      origin: "https://accounts.example.test/reset",
    });
    expect(sandbox.provider).toBe("vercel");
    await sandbox.close();
    expect(closed).toBe(true);
  });
});
