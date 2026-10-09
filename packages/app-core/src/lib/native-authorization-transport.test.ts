import { afterEach, expect, it, vi } from "vitest";
import { captureNativeAuthorizationTransport } from "./native-authorization-transport.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";

const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
});
function browser(attempt: AbortController) {
  releases.push(
    bindNativeOAuthBrowserPort({
      redirectUri: "https://selfhost.example/auth/native-connector.html",
      navigate: () => undefined,
      scrubCallback: () => undefined,
      captureAuthorizationGuard: () => () => attempt.signal.throwIfAborted(),
    }),
  );
}
it("keeps the captured attempt cancelled after a replacement browser reservation", async () => {
  const old = new AbortController();
  browser(old);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "me" }));
  const transport = captureNativeAuthorizationTransport({
    fetch: fetcher,
    assertCurrent: () => undefined,
  });
  await transport.fetch("https://provider.example/me");
  old.abort();
  browser(new AbortController());
  expect(() => transport.assertCurrent()).toThrow();
  expect(() => transport.fetch("https://provider.example/me")).toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
});
it("allows an already submitted mint to settle but blocks verification and new mutations after Cancel", async () => {
  const attempt = new AbortController();
  browser(attempt);
  let finish: (response: Response) => void = () => undefined;
  const mutation = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const base: NativeProviderTransport = {
    fetch: vi.fn<typeof fetch>(async () => Response.json({ id: "me" })),
    assertCurrent: () => undefined,
    settleCredentialMutation: mutation,
  };
  const transport = captureNativeAuthorizationTransport(base);
  const response = transport.settleCredentialMutation?.(
    "https://provider.example/token",
    { method: "POST" },
  );
  attempt.abort();
  finish(Response.json({ access_token: "test-observed-minted-token" }));
  await expect(response?.then((reply) => reply.json())).resolves.toEqual({
    access_token: "test-observed-minted-token",
  });
  expect(() => transport.assertCurrent()).toThrow();
  expect(() => transport.fetch("https://provider.example/me")).toThrow();
  expect(() =>
    transport.settleCredentialMutation?.("https://provider.example/token"),
  ).toThrow();
  expect(mutation).toHaveBeenCalledOnce();
});
it("preserves the captured provider lease even when its browser attempt remains active", () => {
  browser(new AbortController());
  const lease = new AbortController();
  const transport = captureNativeAuthorizationTransport({
    fetch: vi.fn<typeof fetch>(async () => Response.json({ id: "me" })),
    assertCurrent: () => lease.signal.throwIfAborted(),
  });
  lease.abort();
  expect(() => transport.assertCurrent()).toThrow();
});
