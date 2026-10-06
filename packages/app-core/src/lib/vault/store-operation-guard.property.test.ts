import { mintVaultKey } from "@opensesame/vault-core";
import fc from "fast-check";
import { afterEach, beforeAll, expect, it } from "vitest";
import { markDecoySession } from "../decoy-session.js";
import { pinStoreOperation } from "./store-operation-guard.js";
import { guestVaultScope, scopedVaultScope } from "./store-scope.js";

let originalKey: CryptoKey;
let replacementKey: CryptoKey;
beforeAll(async () => {
  originalKey = (await mintVaultKey()).vaultKey;
  replacementKey = (await mintVaultKey()).vaultKey;
});
afterEach(() => markDecoySession(false));

it("rejects generated key, scope, lifecycle, and realm substitutions independently of a combined store restart", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom("key", "scope", "lifecycle", "realm", "no_change"),
        { minLength: 1, maxLength: 32 },
      ),
      (commands) => {
        markDecoySession(false);
        let state = {
          scope: scopedVaultScope(),
          generation: 10,
          vaultKey: originalKey,
        };
        const check = pinStoreOperation(() => state);
        let substituted = false;
        for (const command of commands) {
          switch (command) {
            case "key":
              state = { ...state, vaultKey: replacementKey };
              substituted = true;
              break;
            case "scope":
              state = { ...state, scope: guestVaultScope() };
              substituted = true;
              break;
            case "lifecycle":
              state = { ...state, generation: state.generation + 1 };
              substituted = true;
              break;
            case "realm":
              markDecoySession(true);
              markDecoySession(false);
              substituted = true;
              break;
          }
          if (substituted) expect(check).toThrow();
          else expect(check).not.toThrow();
        }
      },
    ),
    { seed: 1731007, numRuns: 128 },
  );
});

it("permits intentional key admission while preserving scope, lifecycle, and realm isolation", () => {
  markDecoySession(false);
  let state = {
    scope: scopedVaultScope(),
    generation: 10,
    vaultKey: originalKey,
  };
  const check = pinStoreOperation(() => state, true);
  state = { ...state, vaultKey: replacementKey };
  expect(check).not.toThrow();
  markDecoySession(true);
  markDecoySession(false);
  expect(check).toThrow();
});
