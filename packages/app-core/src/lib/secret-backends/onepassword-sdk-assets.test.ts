import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import type { PagePort } from "../../ports.js";
import { clearHostForTest, createTestHost } from "../../test-host.js";
import artifacts from "./onepassword-artifacts.json" with { type: "json" };
import { onePasswordBrowserAssets } from "./onepassword-sdk-loader.js";
import { OnePasswordAssetsSchema } from "./onepassword-worker-protocol.js";

const failure =
  "The 1Password browser assets are not configured for this deployment.";
const constructed = vi.fn();
class ForbiddenWorker extends EventTarget implements Worker {
  onmessage: Worker["onmessage"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  onerror: Worker["onerror"] = null;
  constructor(_url: URL | string, _options?: WorkerOptions) {
    super();
    constructed();
    throw new Error("Asset resolution must not construct a worker");
  }
  postMessage() {}
  terminate() {}
}
function page(origin: string, route = "/"): PagePort {
  return {
    location: {
      origin,
      get href(): string {
        throw new Error(`Asset resolution read document route ${route}`);
      },
      get pathname(): string {
        throw new Error(`Asset resolution read document path ${route}`);
      },
      protocol: "https:",
      host: "unused.example",
      hostname: "unused.example",
      search: "?unused=1",
      hash: "#unused",
      assign() {},
      replace() {},
      reload() {},
    },
    addEventListener() {},
    removeEventListener() {},
    open: () => null,
    close() {},
    opener: null,
    isSecureContext: true,
    visibilityState: "visible",
    replaceUrl() {},
    onVisibilityChange: () => () => {},
    startDownload() {},
    submitForm() {},
  };
}
function install(base: string, origin = "https://pwa.example", route = "/") {
  configureHost(
    createTestHost({
      env: { BASE_URL: base },
      page: page(origin, route),
      worker: ForbiddenWorker,
    }),
  );
}
beforeEach(() => {
  constructed.mockClear();
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Asset resolution must not fetch");
  });
});
afterEach(() => {
  expect(constructed).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  configureHost(createTestHost());
});

it.each([
  ["https://pwa.example", "/", "/"],
  ["https://pwa.example", "/OpenSesame/", "/OpenSesame/"],
  ["https://pwa.example", "/operator/nested/pwa/", "/operator/nested/pwa/"],
  ["https://pwa.example", "operator/nested/pwa/", "/operator/nested/pwa/"],
  ["https://pwa.example", "https://pwa.example/pwa/", "/pwa/"],
  ["https://pwa.example:8443", "/pwa/", "/pwa/"],
  ["https://pwa.example:8443", "https://pwa.example:8443/pwa/", "/pwa/"],
  ["http://localhost:5180", "/OpenSesame/", "/OpenSesame/"],
  ["http://localhost:5180", "http://localhost:5180/", "/"],
])(
  "resolves pinned resources for origin %s and directory %s",
  (origin, base, path) => {
    install(base, origin);
    const assets = onePasswordBrowserAssets();
    expect(assets).toEqual({
      origin,
      runtimeUrl: `${origin}${path}${artifacts.assets.runtime}`,
      wasmUrl: `${origin}${path}${artifacts.assets.wasm}`,
    });
    expect(OnePasswordAssetsSchema.safeParse(assets).success).toBe(true);
    expect(Object.isFrozen(assets)).toBe(true);
  },
);

it("resolves the same deployment on root and deep integration routes", () => {
  install("/OpenSesame/");
  const root = onePasswordBrowserAssets();
  install(
    "/OpenSesame/",
    "https://pwa.example",
    "/settings/integrations/1password",
  );
  expect(onePasswordBrowserAssets()).toEqual(root);
});

it.each([
  "",
  "/OpenSesame",
  "OpenSesame",
  "./",
  "./OpenSesame/",
  "../OpenSesame/",
  "/a/../OpenSesame/",
  "/a/./OpenSesame/",
  "/%2e%2e/OpenSesame/",
  "/a%2fb/",
  "/a%5cb/",
  "/bad%/",
  "/%00/",
  "/%7f/",
  "https:/pwa.example/",
  "https:pwa.example/",
  "https:///pwa.example/pwa/",
  "https://pwa.example:443/pwa/",
  "https://%70wa.example/pwa/",
  "/pwa\\child/",
  "/pwa\nchild/",
  " /pwa/",
  "//pwa.example/pwa/",
  "https://other.example/pwa/",
  "http://pwa.example/pwa/",
  "https://pwa.example:8443/pwa/",
  "https://private-user:private-password@pwa.example/pwa/",
  "https://pwa.example/pwa/?private-query/",
  "https://pwa.example/pwa/#private-fragment/",
  "/pwa/?private-query/",
  "/pwa/#private-fragment/",
  "data:text/plain,private-data/",
])("rejects unsafe deployment base %j with a fixed error", (base) => {
  install(base);
  expect(onePasswordBrowserAssets).toThrowError(new Error(failure));
});

it.each([
  "not-an-origin",
  "https://pwa.example/",
  "https://pwa.example/path",
  "https://user:private-password@pwa.example",
  "https://pwa.example?private-query",
  "https://pwa.example#private-fragment",
  "https://pwa.example:443",
  "https://PWA.example",
  "file:///private/path",
  "null",
])("rejects malformed or noncanonical page origin %j", (origin) => {
  install("/", origin);
  expect(onePasswordBrowserAssets).toThrowError(new Error(failure));
});

it("captures an immutable descriptor and reads the host again on the next call", () => {
  install("/first/");
  const first = onePasswordBrowserAssets();
  install("/second/", "http://localhost:5180");
  const second = onePasswordBrowserAssets();
  expect(first.runtimeUrl).toBe(
    `https://pwa.example/first/${artifacts.assets.runtime}`,
  );
  expect(second.runtimeUrl).toBe(
    `http://localhost:5180/second/${artifacts.assets.runtime}`,
  );
  expect(first.origin).toBe("https://pwa.example");
  expect(second).not.toBe(first);
  expect(() =>
    Object.assign(first, { origin: "https://other.example" }),
  ).toThrow();
});

it("fails at call time when the host or page port is absent", () => {
  clearHostForTest();
  expect(onePasswordBrowserAssets).toThrowError(new Error(failure));
  configureHost(createTestHost({ page: undefined }));
  expect(onePasswordBrowserAssets).toThrowError(new Error(failure));
});

it("imports the loader without requiring a host or starting its SDK", async () => {
  clearHostForTest();
  vi.resetModules();
  const loader = await import("./onepassword-sdk-loader.js");
  expect(loader.onePasswordBrowserAssets).toBeTypeOf("function");
  expect(loader.onePasswordBrowserAssets).toThrowError(new Error(failure));
  install("/after-import/");
  expect(loader.onePasswordBrowserAssets().wasmUrl).toBe(
    `https://pwa.example/after-import/${artifacts.assets.wasm}`,
  );
});
