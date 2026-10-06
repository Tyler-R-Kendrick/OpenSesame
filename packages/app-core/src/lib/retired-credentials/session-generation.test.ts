import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { markDecoySession } from "../decoy-session.js";
import { clearActivePresentation } from "../duress/compartment/presentation-runtime.js";
import { openRetiredCredentialDecoy } from "./session.js";
import { createRetiredCredentialFixture } from "./test-support.js";

let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearActivePresentation();
  fixture.restore();
});

it("withholds synthetic construction after a realm reset during actual compartment encryption", async () => {
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "encrypt").mockImplementation(
    (algorithm, key, data) => {
      markDecoySession(true);
      markDecoySession(false);
      return encrypt(algorithm, key, data);
    },
  );
  const guest = vi.spyOn(fixture.store, "createGuest");
  await expect(
    openRetiredCredentialDecoy(
      fixture.store,
      {
        id: "selected",
        createdAt: new Date().toISOString(),
        response: "synthetic_decoy",
      },
      "personal",
    ),
  ).rejects.toThrow(/authenticate again/);
  expect(guest).not.toHaveBeenCalled();
  expect(fixture.store.getSnapshot()).toMatchObject({
    status: "locked",
    header: null,
    items: [],
  });
});
