import { overlapCast } from "@opensesame/os-domain";
import {
  type VaultBody,
  createItem,
  importVaultKey,
  openJson,
  unwrapRawVaultKeyFromPassword,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OWNER_PASSWORD,
  type OwnerTransition,
  deferred,
  encryptedOwner,
} from "../../../__tests__/backup-prf-owner.test-support.js";
import {
  BODY_PATH,
  HEADER_PATH,
  PERSONAL_TOMB,
  readPlaintextFile,
  readSealedFile,
} from "../../../vfs.js";
import { vaultStore } from "../../store.js";
import { disposeRootKeyHandle, isRootKeyHandle } from "../adapter.js";
import { verifyManifestAuth } from "../manifest-auth.js";
import { contextForRecord } from "../record-context.js";
import { createWebauthnPrfProtector } from "./webauthn-prf-ops.js";
import {
  PhysicalCredential,
  physicalAuthenticator,
} from "./webauthn-prf.physical.test-support.js";

const SECRET = "actual encrypted owner body opened with a PRF-derived key";
let owner: Awaited<ReturnType<typeof encryptedOwner>>;
let physical: ReturnType<typeof physicalAuthenticator>;

beforeEach(async () => {
  physical = physicalAuthenticator();
  owner = await encryptedOwner(physical.port);
  const item = createItem("secret", "PRF encrypted owner proof");
  item.value = SECRET;
  await vaultStore.addItems([item]);
  await vaultStore.flushPendingWrites();
});
afterEach(async () => {
  await owner.recoverOwner();
  await owner.close();
});

async function enrollPrf() {
  const candidate = await vaultStore.protection.enrollCandidate("webauthn-prf");
  await vaultStore.protection.commitEnrollment(candidate.operationId);
  await vaultStore.flushPendingWrites();
  const header = vaultStore.getSnapshot().header;
  if (!header?.protection || candidate.record.kind !== "webauthn-prf") {
    throw new Error("Expected an actual committed PRF owner protector");
  }
  return {
    candidate,
    header,
    record: candidate.record,
    manifest: header.protection,
  };
}

describe("PRF adapter with an authenticated encrypted owner", () => {
  it("wraps, proves, opens and admits the same root without changing the password wrap", async () => {
    const passwordWrap = vaultStore.getSnapshot().header?.wrap;
    const { candidate, header, record, manifest } = await enrollPrf();
    const adapter = createWebauthnPrfProtector({
      sessionGeneration: candidate.sessionGeneration,
    });
    expect(adapter.capabilities()).toMatchObject({ runtime: "available" });
    expect(header.wrap).toEqual(passwordWrap);
    const createOptions = physical.create.mock.calls[0]?.[0]?.publicKey;
    expect(createOptions?.rp.id).toBe("localhost");
    expect(createOptions?.authenticatorSelection?.userVerification).toBe(
      "required",
    );
    const request = {
      operationId: candidate.operationId,
      sessionGeneration: candidate.sessionGeneration,
      context: contextForRecord(manifest, record.protectorId),
      record,
    };
    const proof = await adapter.prove(request);
    expect(proof.evidence).toMatchObject({ kind: "browser" });
    const opened = await adapter.open(request);
    const passwordRoot = await unwrapRawVaultKeyFromPassword(
      header,
      OWNER_PASSWORD,
    );
    try {
      expect(isRootKeyHandle(opened)).toBe(true);
      expect(opened.bytes).toEqual(passwordRoot);
      await verifyManifestAuth(opened.bytes, manifest);
      const body = readSealedFile(PERSONAL_TOMB, BODY_PATH);
      if (!body) throw new Error("Expected persisted owner ciphertext");
      const plaintext = await openJson<VaultBody>(
        await importVaultKey(opened.bytes),
        body,
        vaultSealBinding(PERSONAL_TOMB, BODY_PATH),
      );
      expect(
        plaintext.items.some(
          (item) => item.kind === "secret" && item.value === SECRET,
        ),
      ).toBe(true);
    } finally {
      passwordRoot.fill(0);
      disposeRootKeyHandle(opened);
      await adapter.dispose();
    }
    expect(new Uint8Array(opened.bytes)).toEqual(new Uint8Array(32));
    const getOptions = physical.get.mock.calls[0]?.[0]?.publicKey;
    expect(getOptions?.userVerification).toBe("required");
    expect(getOptions?.allowCredentials).toHaveLength(1);
    vaultStore.lock();
    await vaultStore.unlockWithPasskey();
    expect(vaultStore.getSnapshot().status).toBe("unlocked");
    expect(
      vaultStore
        .getSnapshot()
        .items.some((item) => item.kind === "secret" && item.value === SECRET),
    ).toBe(true);
  });

  it("refuses canceled, mismatched-generation and wrong-kind adapter operations before hardware access", async () => {
    const { candidate, record, manifest } = await enrollPrf();
    const adapter = createWebauthnPrfProtector({
      sessionGeneration: candidate.sessionGeneration,
    });
    const request = {
      operationId: candidate.operationId,
      sessionGeneration: candidate.sessionGeneration,
      context: contextForRecord(manifest, record.protectorId),
      record,
    };
    const abort = new AbortController();
    abort.abort();
    await expect(
      adapter.prove({ ...request, signal: abort.signal }),
    ).rejects.toMatchObject({ code: "canceled" });
    await expect(
      adapter.open({
        ...request,
        sessionGeneration: candidate.sessionGeneration + 1,
      }),
    ).rejects.toMatchObject({ code: "stale_operation" });
    const password = manifest.records.find((row) => row.kind === "password");
    if (!password) throw new Error("Expected actual password protector");
    await expect(
      adapter.prove({ ...request, record: password }),
    ).rejects.toMatchObject({ code: "malformed_encoding" });
    await expect(
      adapter.open({ ...request, record: password }),
    ).rejects.toMatchObject({ code: "malformed_encoding" });
    expect(physical.get).not.toHaveBeenCalled();
  });

  it.each([
    ["cancel", "canceled"],
    ["abort", "canceled"],
    ["null", "canceled"],
    ["unsupported", "unsupported_runtime"],
    ["unexpected-credential", "unsupported_runtime"],
    ["enabled-only", "unsupported_runtime"],
    ["missing-output", "unsupported_runtime"],
    ["short-output", "unsupported_runtime"],
    ["origin", "context_mismatch"],
    ["rp", "context_mismatch"],
  ] as const)(
    "does not persist a protector after physical create returns %s",
    async (outcome, code) => {
      const header = readPlaintextFile(PERSONAL_TOMB, HEADER_PATH);
      const protectors = vaultStore.protection.listProtectors();
      physical.create.mockImplementationOnce(async () => {
        if (outcome === "cancel")
          throw new DOMException(
            "fixture user cancellation",
            "NotAllowedError",
          );
        if (outcome === "abort")
          throw new DOMException("fixture hardware aborted", "AbortError");
        if (outcome === "null") return null;
        if (outcome === "unsupported")
          throw new Error("fixture native authenticator unavailable");
        if (outcome === "unexpected-credential")
          return { id: "fixture-password", type: "password" };
        if (outcome === "enabled-only")
          return new PhysicalCredential(
            physical.credentialId,
            overlapCast({ prf: { enabled: true } }),
          );
        if (outcome === "missing-output")
          return new PhysicalCredential(physical.credentialId, {});
        if (outcome === "short-output")
          return physical.credential("webauthn.create", new ArrayBuffer(8));
        return new PhysicalCredential(
          physical.credentialId,
          overlapCast({
            prf: { results: { first: physical.output.slice(0) } },
          }),
          "webauthn.create",
          outcome === "origin"
            ? "https://other.example.test"
            : "http://localhost",
          outcome === "rp" ? "other.example.test" : "localhost",
        );
      });
      await expect(
        vaultStore.protection.enrollCandidate("webauthn-prf"),
      ).rejects.toMatchObject({ code });
      expect(vaultStore.protection.listProtectors()).toEqual(protectors);
      expect(readPlaintextFile(PERSONAL_TOMB, HEADER_PATH)).toBe(header);
      expect(vaultStore.getSnapshot().status).toBe("unlocked");
    },
  );

  it.each(["cancel", "wrong-credential", "origin"] as const)(
    "refuses an untrusted %s assertion for prove and open",
    async (outcome) => {
      const { candidate, record, manifest } = await enrollPrf();
      const adapter = createWebauthnPrfProtector({
        sessionGeneration: candidate.sessionGeneration,
      });
      const request = {
        operationId: candidate.operationId,
        sessionGeneration: candidate.sessionGeneration,
        context: contextForRecord(manifest, record.protectorId),
        record,
      };
      const header = readPlaintextFile(PERSONAL_TOMB, HEADER_PATH);
      const wrongCredential = new Uint8Array(physical.credentialId.slice(0));
      wrongCredential[0] = (wrongCredential[0] ?? 0) ^ 1;
      physical.get.mockImplementation(async () => {
        if (outcome === "cancel")
          throw new DOMException(
            "fixture user cancellation",
            "NotAllowedError",
          );
        return new PhysicalCredential(
          outcome === "wrong-credential"
            ? wrongCredential.buffer
            : physical.credentialId,
          overlapCast({
            prf: { results: { first: physical.output.slice(0) } },
          }),
          "webauthn.get",
          outcome === "origin"
            ? "https://other.example.test"
            : "http://localhost",
        );
      });
      const code =
        outcome === "cancel"
          ? "canceled"
          : outcome === "origin"
            ? "context_mismatch"
            : "enrollment_proof_failed";
      await expect(adapter.prove(request)).rejects.toMatchObject({ code });
      await expect(adapter.open(request)).rejects.toMatchObject({ code });
      expect(readPlaintextFile(PERSONAL_TOMB, HEADER_PATH)).toBe(header);
    },
  );
});

describe("late physical PRF completion cannot admit a replaced owner context", () => {
  it.each(["lock", "synthetic", "fresh-owner"] as const)(
    "discards enrollment completed after %s",
    async (transition: OwnerTransition) => {
      const entered = deferred<void>();
      const release = deferred<Credential | null>();
      physical.create.mockImplementationOnce(async () => {
        entered.resolve();
        return release.promise;
      });
      const pending = vaultStore.protection
        .enrollCandidate("webauthn-prf")
        .then(
          () => null,
          (error: Error) => error,
        );
      try {
        await entered.promise;
        await owner.transition(transition);
        const snapshot = vaultStore.getSnapshot();
        const header = readPlaintextFile(PERSONAL_TOMB, HEADER_PATH);
        release.resolve(physical.credential());
        expect(await pending).toBeInstanceOf(Error);
        expect(vaultStore.getSnapshot()).toEqual(snapshot);
        expect(readPlaintextFile(PERSONAL_TOMB, HEADER_PATH)).toBe(header);
        if (transition === "fresh-owner") {
          const fresh =
            await vaultStore.protection.enrollCandidate("webauthn-prf");
          await vaultStore.protection.commitEnrollment(fresh.operationId);
          expect(
            vaultStore.protection
              .listProtectors()
              .some((row) => row.protectorId === fresh.record.protectorId),
          ).toBe(true);
        }
      } finally {
        release.resolve(physical.credential());
        await pending;
      }
    },
  );

  it.each(["lock", "synthetic", "fresh-owner"] as const)(
    "wipes a probe returned after %s without replacing the current session",
    async (transition: OwnerTransition) => {
      await enrollPrf();
      vaultStore.lock();
      const entered = deferred<void>();
      const release = deferred<Credential | null>();
      const staleOutput = physical.output.slice(0);
      physical.get.mockImplementationOnce(async () => {
        entered.resolve();
        return release.promise;
      });
      const pending = vaultStore.probePasskeyCeremony().then(
        () => null,
        (error: Error) => error,
      );
      try {
        await entered.promise;
        await owner.transition(transition);
        const snapshot = vaultStore.getSnapshot();
        const header = readPlaintextFile(PERSONAL_TOMB, HEADER_PATH);
        release.resolve(physical.credential("webauthn.get", staleOutput));
        expect(await pending).toBeInstanceOf(Error);
        expect(new Uint8Array(staleOutput)).toEqual(new Uint8Array(32));
        expect(vaultStore.getSnapshot()).toEqual(snapshot);
        expect(readPlaintextFile(PERSONAL_TOMB, HEADER_PATH)).toBe(header);
        if (transition === "fresh-owner") {
          vaultStore.lock();
          await vaultStore.unlockWithPasskey();
          expect(vaultStore.getSnapshot().status).toBe("unlocked");
        }
      } finally {
        release.resolve(physical.credential("webauthn.get", staleOutput));
        await pending;
      }
    },
  );
});
