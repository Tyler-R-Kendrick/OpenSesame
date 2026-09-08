import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { browserPairingSeams } from "../lib/browser-pairing.js";
export const HEALTH = {
  status: "ok",
  service: "opensesame-daemon",
  hostApi: "https://host.example.com",
  identityApi: "https://id.example.com",
  tailscaleUrl: null,
};
export function typeDaemonUrl(value: string) {
  fireEvent.change(screen.getByLabelText("Daemon (Tailscale Serve URL)"), {
    target: { value },
  });
}
const eligible = browserPairingSeams.eligible;
const createKey = browserPairingSeams.createKey;
beforeEach(() => {
  browserPairingSeams.eligible = () => true;
});
afterEach(() => {
  browserPairingSeams.eligible = eligible;
  browserPairingSeams.createKey = createKey;
  vi.unstubAllGlobals();
});

export function mockLocalApproval() {
  browserPairingSeams.createKey = async () => ({
    jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    createDpopProof: async () => "test-proof",
  });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          pairing_id: "pair-1",
          device_code: "d".repeat(40),
          user_code: "ABCD-1234",
          verification_uri: "https://host.example.com/pair",
          expires_in: 300,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "test-only-sync-token-with-at-least-32-bytes",
          token_type: "DPoP",
          client_id: "client-1",
          expires_in: 300,
          scope: "host.sync.read host.sync.write",
        }),
      ),
  );
}
