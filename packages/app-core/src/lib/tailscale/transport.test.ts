import { expect, it, vi } from "vitest";
import { bindTailscaleTransport, tailscaleTransport } from "./transport.js";
it("requires an explicit current direct transport and old cleanup cannot remove a later lease", () => {
  expect(() => tailscaleTransport()).toThrow("Enable External connectors");
  const first = { fetch: vi.fn<typeof fetch>(), assertCurrent: vi.fn() };
  const releaseFirst = bindTailscaleTransport(first);
  expect(tailscaleTransport()).toBe(first);
  const next = { fetch: vi.fn<typeof fetch>(), assertCurrent: vi.fn() };
  const releaseNext = bindTailscaleTransport(next);
  releaseFirst();
  expect(tailscaleTransport()).toBe(next);
  expect(next.assertCurrent).toHaveBeenCalledOnce();
  releaseNext();
  expect(() => tailscaleTransport()).toThrow("Enable External connectors");
});
