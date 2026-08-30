/** @vitest-environment jsdom */
import { webmcpPwaCatalog } from "@opensesame/capability-registry";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import type { Session } from "@opensesame/sdk-browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClientSeams } from "./api-client";
import { sdkBrowserSeams } from "./sdk-browser";
import { pwaWebMcpTools, registerPwaWebMcp } from "./webmcp";

const CONFIG = {
  hostApi: "http://127.0.0.1:8787",
  issuer: "http://127.0.0.1:8788",
};

const originalApiSeams = { ...apiClientSeams };
const originalSdkSeams = { ...sdkBrowserSeams };

type RegisteredTool = {
  name: string;
  execute: (args: JsonObject) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;
};

function stubSession(session: Session | null) {
  const getSession = vi.fn(async () => session);
  const signIn = vi.fn();
  sdkBrowserSeams.createOpenSesame = () => ({
    getSession,
    signIn,
    continueAnonymously: vi.fn(),
    signOut: vi.fn(),
  });
  return { getSession, signIn };
}

function stubHost(hostOk: boolean, daemonAvailable: boolean) {
  apiClientSeams.createApiClient = () => ({
    health: vi.fn(async () => ({ ok: hostOk, body: "" })),
    probeDaemon: vi.fn(async () => ({
      available: daemonAvailable,
      url: "http://127.0.0.1:18790",
    })),
  });
}

afterEach(() => {
  Object.assign(apiClientSeams, originalApiSeams);
  Object.assign(sdkBrowserSeams, originalSdkSeams);
  Reflect.deleteProperty(overlapCast(window.navigator), "modelContext");
  document.body.innerHTML = "";
});

describe("registry parity", () => {
  it("implements exactly the registry-derived pwa catalog", () => {
    stubSession(null);
    const names = new Set(pwaWebMcpTools(CONFIG).map((tool) => tool.name));
    expect(names).toEqual(new Set(webmcpPwaCatalog()));
    expect(names.size).toBe(3);
  });
});

describe("pwa WebMCP tools", () => {
  it("status reports the session without leaking the token", async () => {
    stubSession({
      accessToken: "token-abcdef",
      anonymous: true,
      sub: "sub_guest",
      raw: { access_token: "token-abcdef", token_type: "Bearer" },
    });
    const status = pwaWebMcpTools(CONFIG).find(
      (tool) => tool.name === "opensesame_pwa_status",
    );
    const result = await status?.execute({});
    expect(result).toEqual({
      signedIn: true,
      anonymous: true,
      sub: "sub_guest",
    });
    expect(JSON.stringify(result)).not.toContain("token-abcdef");
  });

  it("health probes host and daemon through the existing client seam", async () => {
    stubSession(null);
    stubHost(true, false);
    const health = pwaWebMcpTools(CONFIG).find(
      (tool) => tool.name === "opensesame_pwa_health",
    );
    await expect(health?.execute({})).resolves.toEqual({
      hostApi: CONFIG.hostApi,
      hostOk: true,
      daemonAvailable: false,
    });
  });

  it("open_sign_in focuses the sign-in control and never authenticates", async () => {
    const { getSession, signIn } = stubSession(null);
    document.body.innerHTML =
      '<button type="button" data-webmcp="sign-in">Sign in</button>';
    const open = pwaWebMcpTools(CONFIG).find(
      (tool) => tool.name === "opensesame_open_sign_in",
    );
    await expect(open?.execute({})).resolves.toEqual({
      status: "ceremony_opened",
      location: "/",
    });
    expect(document.activeElement?.getAttribute("data-webmcp")).toBe("sign-in");
    expect(getSession).toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("open_sign_in reports an existing session instead of reopening", async () => {
    stubSession({
      accessToken: "token",
      anonymous: false,
      sub: "sub_person",
      raw: { access_token: "token", token_type: "Bearer" },
    });
    const open = pwaWebMcpTools(CONFIG).find(
      (tool) => tool.name === "opensesame_open_sign_in",
    );
    await expect(open?.execute({})).resolves.toEqual({
      status: "already_signed_in",
    });
  });
});

describe("registerPwaWebMcp", () => {
  it("no-ops without navigator.modelContext", () => {
    stubSession(null);
    const unregister = registerPwaWebMcp(CONFIG);
    expect(unregister).toBeInstanceOf(Function);
    unregister();
  });

  it("registers fenced tools when the API exists", async () => {
    stubSession(null);
    stubHost(true, true);
    const tools: RegisteredTool[] = [];
    Object.defineProperty(window.navigator, "modelContext", {
      value: {
        registerTool(tool: RegisteredTool) {
          tools.push(tool);
          return () => {
            tools.splice(tools.indexOf(tool), 1);
          };
        },
      },
      configurable: true,
    });
    const unregister = registerPwaWebMcp(CONFIG);
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set(webmcpPwaCatalog()),
    );
    const health = tools.find((tool) => tool.name === "opensesame_pwa_health");
    const result = await health?.execute({});
    expect(result?.content[0]?.text).toContain('"hostOk":true');
    unregister();
    expect(tools).toHaveLength(0);
  });
});
