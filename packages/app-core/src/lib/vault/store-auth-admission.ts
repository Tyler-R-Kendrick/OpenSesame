import { type VaultHeader, WrongPasswordError } from "@opensesame/vault-core";
/** Fresh cryptographic proofs stay bound to their actual authentication context. */
import {
  admitFreshOwnerAuthentication,
  assertAuthenticationSession,
  freshOwnerAuthenticationTomb,
  freshOwnerAuthenticationVault,
  requiresFreshOwnerAuthentication,
} from "../decoy-session.js";
import type { PasskeyProbeOptions } from "./passkey-unlock-session.js";
import type { GuardedUnlockHost } from "./primary-unlock-session.js";
import { verifyManifestAuth } from "./protection/manifest-auth.js";
import type { ProtectorUnlockInput } from "./protector-unlock-session.js";
import { spendRecoveryCode } from "./recovery-codes.js";
import {
  type MfaAuthenticationPermit,
  issueMfaAuthenticationPermit,
} from "./remote-code-admission.js";
import {
  authenticationHeaderWitness,
  currentAuthenticationHeader,
  publishAuthenticatedSession,
  validateAuthenticationHeader,
} from "./store-auth-header.js";
import { loadVaultBody } from "./store-body.js";
import { recoverPreparedRoot } from "./store-root-rotation-loader.js";
import type { VaultScope } from "./store-scope.js";
import { guardedUnlockHost } from "./store-unlock-host.js";
import {
  probeGuardedPasskey,
  probeGuardedProtector,
} from "./store-unlock-probe.js";
import { vaultIdentity } from "./store-vault-identity.js";
import { assertNotLockedOut } from "./unlock-attempts.js";
type ProofOrigin = {
  tomb: string;
  realm: number;
  vaultIdentity: string | null;
  headerWitness: string;
  assertCurrent: () => void;
};
export class StoreAuthenticationAdmission {
  readonly #roots = new WeakMap<CryptoKey, ProofOrigin>();
  readonly #permits = new WeakMap<CryptoKey, MfaAuthenticationPermit>();
  readonly #held = new WeakMap<ArrayBuffer, ProofOrigin>();
  constructor(
    readonlyHeader: () => VaultHeader | null,
    readonlyRaw: () => Uint8Array,
  ) {
    this.#header = readonlyHeader;
    this.#raw = readonlyRaw;
  }
  readonly #header: () => VaultHeader | null;
  readonly #raw: () => Uint8Array;
  #identity(): string | null {
    return vaultIdentity(this.#header());
  }
  capture(tomb: string, assertCurrent: () => void): ProofOrigin {
    return {
      tomb,
      realm: assertAuthenticationSession(),
      vaultIdentity: this.#identity(),
      headerWitness: authenticationHeaderWitness(this.#header()),
      assertCurrent,
    };
  }
  async createHost(
    scope: VaultScope,
    check: () => void,
    assignHeader: (header: VaultHeader | null) => void,
    recordMiss: () => void,
    stash: (raw: Uint8Array) => void,
    continueSession: (
      key: CryptoKey,
      miss: string | undefined,
      check: () => void,
    ) => Promise<void>,
  ): Promise<GuardedUnlockHost> {
    await recoverPreparedRoot(scope.tomb, this.#header(), check);
    const header = await currentAuthenticationHeader(scope.tomb, check);
    check();
    assignHeader(header);
    const origin = this.capture(scope.tomb, check);
    return guardedUnlockHost({
      header,
      assertCurrent: check,
      assertNotLockedOut: () => assertNotLockedOut(scope.attempts),
      recordFailedUnlock: recordMiss,
      stashRaw: stash,
      afterPrimaryUnwrap: async (key, miss) => {
        await this.recordRoot(key, origin, check);
        return continueSession(key, miss, check);
      },
    });
  }
  async recordRoot(
    key: CryptoKey,
    origin: ProofOrigin,
    check: () => void,
  ): Promise<void> {
    check();
    assertAuthenticationSession(origin.realm);
    await validateAuthenticationHeader(
      origin.tomb,
      origin.headerWitness,
      check,
    );
    check();
    if (requiresFreshOwnerAuthentication()) {
      if (
        origin.tomb !== freshOwnerAuthenticationTomb() ||
        origin.vaultIdentity !== freshOwnerAuthenticationVault()
      )
        throw new Error(
          "Authenticate the original vault before using member capabilities.",
        );
      // A plaintext manifest identity is eligible only after its MAC verifies under the actual fresh root.
      const protection = this.#header()?.protection;
      if (protection) await verifyManifestAuth(this.#raw(), protection);
      check();
      assertAuthenticationSession(origin.realm);
    }
    this.#roots.set(key, origin);
  }
  async trackHeld<T>(
    proof: Promise<T>,
    check: () => void,
    buffer: (value: T) => ArrayBuffer,
    tomb: string,
  ): Promise<T> {
    const origin = this.capture(tomb, check);
    const value = await proof;
    const raw = buffer(value);
    try {
      await validateAuthenticationHeader(tomb, origin.headerWitness, check);
      check();
      assertAuthenticationSession(origin.realm);
      this.#held.set(raw, origin);
      return value;
    } catch (error) {
      new Uint8Array(raw).fill(0);
      throw error;
    }
  }
  probePasskey(
    host: GuardedUnlockHost,
    options: PasskeyProbeOptions | undefined,
    tomb: string,
  ) {
    return this.trackHeld(
      probeGuardedPasskey(host, options),
      host.assertCurrent,
      (proof) => proof.prfOutput,
      tomb,
    );
  }
  probeProtector(
    host: GuardedUnlockHost,
    input: ProtectorUnlockInput,
    tomb: string,
  ) {
    return this.trackHeld(
      probeGuardedProtector(host, input),
      host.assertCurrent,
      (proof) => proof,
      tomb,
    );
  }
  async assertHeld(buffer: ArrayBuffer, tomb: string): Promise<void> {
    const origin = this.#held.get(buffer);
    if (!origin && !requiresFreshOwnerAuthentication()) return;
    try {
      if (
        !origin ||
        origin.tomb !== tomb ||
        origin.vaultIdentity !== this.#identity()
      )
        throw new Error("A fresh credential proof is required.");
      assertAuthenticationSession(origin.realm);
      await validateAuthenticationHeader(tomb, origin.headerWitness, () => {
        assertAuthenticationSession(origin.realm);
      });
    } catch (error) {
      new Uint8Array(buffer).fill(0);
      throw error;
    }
  }
  permit(key: CryptoKey, tomb: string): MfaAuthenticationPermit {
    const origin = this.#roots.get(key);
    if (
      !origin ||
      origin.tomb !== tomb ||
      origin.vaultIdentity !== this.#identity()
    )
      throw new Error("A fresh credential proof is required.");
    assertAuthenticationSession(origin.realm);
    let permit = this.#permits.get(key);
    if (!permit) {
      permit = issueMfaAuthenticationPermit(
        tomb,
        origin.realm,
        origin.vaultIdentity,
        async () => {
          origin.assertCurrent();
          await this.validate(key, tomb, origin.assertCurrent);
          origin.assertCurrent();
        },
        origin.assertCurrent,
      );
      this.#permits.set(key, permit);
    }
    return permit;
  }
  async validate(
    key: CryptoKey,
    tomb: string,
    check: () => void,
  ): Promise<void> {
    const origin = this.#roots.get(key);
    if (!origin || origin.tomb !== tomb)
      throw new Error("A fresh credential proof is required.");
    assertAuthenticationSession(origin.realm);
    const raw = this.#raw();
    try {
      await validateAuthenticationHeader(tomb, origin.headerWitness, check);
    } catch (error) {
      this.#roots.delete(key);
      this.#permits.delete(key);
      raw.fill(0);
      throw error;
    }
  }
  async activate(
    key: CryptoKey,
    tomb: string,
    check: () => void,
    publish: () => void,
  ): Promise<void> {
    const origin = this.#roots.get(key);
    if (!origin || origin.tomb !== tomb)
      throw new Error("A fresh credential proof is required.");
    assertAuthenticationSession(origin.realm);
    const raw = this.#raw();
    try {
      await publishAuthenticatedSession(
        tomb,
        origin.headerWitness,
        check,
        async (header) => {
          await loadVaultBody(tomb, key, header);
          check();
          if (header.protection)
            await verifyManifestAuth(raw, header.protection);
          check();
        },
        () => {
          admitFreshOwnerAuthentication(
            tomb,
            origin.realm,
            origin.vaultIdentity,
          );
          publish();
        },
      );
    } catch (error) {
      this.#roots.delete(key);
      this.#permits.delete(key);
      raw.fill(0);
      throw error;
    }
  }
  async spendRecovery(
    key: CryptoKey | null,
    tomb: string,
    code: string,
    check: () => void,
    persist: (header: VaultHeader) => Promise<void>,
    recordMiss: () => void,
  ): Promise<CryptoKey> {
    const header = this.#header();
    const record = header?.unlocks?.recovery;
    if (!key || !header || !record)
      throw new WrongPasswordError("That recovery code is not valid.");
    await this.validate(key, tomb, check);
    const codesWrap = await spendRecoveryCode(key, record, code, recordMiss);
    check();
    const next = {
      ...header,
      unlocks: { ...header.unlocks, recovery: { ...record, codesWrap } },
    };
    await persist(next);
    check();
    const origin = this.#roots.get(key);
    if (!origin) throw new Error("A fresh credential proof is required.");
    const expected = authenticationHeaderWitness(next);
    await validateAuthenticationHeader(tomb, expected, check, () => {
      origin.headerWitness = expected;
    });
    return key;
  }
}
