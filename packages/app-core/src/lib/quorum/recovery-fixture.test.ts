/**
 * The native reader and this one, each against the other's output (ADR 0186
 * follow-up 3, ADR 0139: one definition, every target).
 *
 * `spec/conformance/quorum-recovery-fixture.json` is a small circle made once
 * by this file: a signed policy, the recovery bundle, every guardian's
 * SLIP-0039 share (as the HPKE delivery that carried it and as the mnemonic it
 * opens to) and the payload. The keys in it are generated for the fixture and
 * protect nothing. This suite decrypts it; `crates/quorum-recovery/tests/
 * fixture.rs` decrypts the same bytes with the native reader.
 *
 * The second half runs on demand (`scripts/test/quorum-recovery-interop.sh`,
 * which sets `OPENSESAME_QUORUM_INTEROP_DIR`): TypeScript writes a fresh circle
 * to a temp directory, the native reader recombines and opens it, then writes a
 * bundle and releases of its own, and TypeScript opens those. There is no seam
 * in `circle.ts` to inject randomness, so the circle is fresh each run rather
 * than seeded; the committed fixture is the stable half.
 *
 * Regenerate the committed file only when the format changes on purpose:
 * `UPDATE_QUORUM_RECOVERY_FIXTURE=1 pnpm --filter @opensesame/app-core exec
 * vitest run src/lib/quorum/recovery-fixture.test.ts`, then
 * `pnpm exec biome format --write spec/conformance/quorum-recovery-fixture.json`
 * (the lint gate formats JSON).
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASE_HPKE_INFO, releaseAad } from "./approve.js";
import {
  fromB64url,
  randomBytes,
  toB64url,
  utf8Bytes,
  utf8Text,
} from "./bytes.js";
import type { Json } from "./canonical.js";
import {
  type CircleDraft,
  MAX_RECOVERY_EXPONENT,
  type RecoveryBundle,
  RecoveryBundleSchema,
  type ShareDelivery,
  assembleCircle,
  createCircle,
  deliveryAad,
  generateOwnerKeys,
  openBundle,
} from "./circle.js";
import { newCircleId } from "./enroll.js";
import { generateKeyPair, openBase } from "./hpke.js";
import { verifySignedPolicy } from "./policy.js";
import { combineMnemonics } from "./slip39/index.js";
import type { Guardian } from "./types.js";
import { shareCommitment } from "./wrap.js";

/** `circle.ts` keeps this private; pinned here so a change to it fails this file. */
const DELIVERY_INFO = "opensesame:quorum-delivery:v1";
const FIXTURE = new URL(
  "../../../../../spec/conformance/quorum-recovery-fixture.json",
  import.meta.url,
);
const NOW = new Date("2026-10-10T12:00:00.000Z");
const ABOUT =
  "Test-only keys: every key, share and secret in this file was generated for it and protects nothing. A two-level circle (2 of 3 family and 2 of 3 friends) made by packages/app-core/src/lib/quorum/recovery-fixture.test.ts; opened by that file and by crates/quorum-recovery/tests/fixture.rs.";

const PEOPLE = [
  { id: "ada", name: "Ada", group: "family" },
  { id: "ben", name: "Ben", group: "family" },
  { id: "cy", name: "Cy", group: "family" },
  { id: "dee", name: "Dee", group: "friends" },
  { id: "eli", name: "Eli", group: "friends" },
  { id: "fay", name: "Fay", group: "friends" },
] as const;
/** Two from each group: the smallest sets that recombine. */
const QUORUM = ["ada", "cy", "eli", "fay"];

const payloadWith = (note: string): Json => ({
  kind: "emergency-collection",
  name: "Family emergency",
  items: [
    { path: "Bank/Checking", username: "fixture", secret: "fixture-only-1" },
    { path: "Home/Wi-Fi", secret: "fixture-only-2" },
  ],
  note,
});
const PAYLOAD = payloadWith("unicode survives the trip: é, 日本語, 🔐");

type FixtureGuardian = Readonly<{
  id: string;
  name: string;
  group: string;
  mnemonic: string;
  hpkeSecretKey: string;
  delivery: ShareDelivery;
}>;

type Fixture = Readonly<{
  about: string;
  generator: string;
  ownerPublicKey: string;
  bundle: RecoveryBundle;
  payload: Json;
  /** The exact text that was sealed. */
  payloadText: string;
  quorum: readonly string[];
  guardians: readonly FixtureGuardian[];
}>;

type Keyed = Readonly<{ guardian: Guardian; secretKey: Uint8Array }>;

function spki(): string {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return toB64url(
    new Uint8Array(publicKey.export({ type: "spki", format: "der" })),
  );
}

function keyedGuardians(): readonly Keyed[] {
  return PEOPLE.map((person) => {
    const pair = generateKeyPair();
    return {
      secretKey: pair.secretKey,
      guardian: {
        id: person.id,
        name: person.name,
        contactRef: null,
        custodyDomain: `home-${person.id}`,
        hpkePublicKey: toB64url(pair.publicKey),
        credentials: [
          {
            credentialId: toB64url(randomBytes(16)),
            publicKey: spki(),
            alg: -7 as const,
            label: "Security key",
            prf: true,
            addedAt: NOW.toISOString(),
          },
        ],
      },
    };
  });
}

function draftOf(keyed: readonly Keyed[]): CircleDraft {
  const members = (group: string) =>
    PEOPLE.filter((p) => p.group === group).map((p) => p.id);
  return {
    circleId: newCircleId(),
    label: "Family",
    collection: "Family emergency",
    rpId: "vault.example.test",
    origins: ["https://vault.example.test"],
    guardians: keyed.map((k) => k.guardian),
    groups: [
      { id: "family", threshold: 2, guardianIds: members("family") },
      { id: "friends", threshold: 2, guardianIds: members("friends") },
    ],
    groupThreshold: 2,
    operations: ["recover-collection"],
    approvalWindowSec: 900,
    releaseDelaySec: 86_400,
    requestLifetimeSec: 7 * 86_400,
    requireUserVerification: true,
  };
}

function mnemonicOf(delivery: ShareDelivery, secretKey: Uint8Array): string {
  return utf8Text(
    openBase({
      recipientSecretKey: secretKey,
      enc: fromB64url(delivery.enc),
      info: utf8Bytes(DELIVERY_INFO),
      aad: deliveryAad(delivery.circleId, delivery.guardianId, delivery.epoch),
      ciphertext: fromB64url(delivery.ciphertext),
    }),
  );
}

function fixtureOf(
  ownerPublicKey: string,
  created: Awaited<ReturnType<typeof createCircle>>,
  keyed: readonly Keyed[],
  payload: Json = PAYLOAD,
): Fixture {
  if (!created.bundle) throw new Error("a recovering circle has a bundle");
  const guardians = PEOPLE.map((person) => {
    const delivery = created.deliveries.find((d) => d.guardianId === person.id);
    const secretKey = keyed.find((k) => k.guardian.id === person.id)?.secretKey;
    if (!delivery || !secretKey) throw new Error("a guardian has no delivery");
    return {
      ...person,
      mnemonic: mnemonicOf(delivery, secretKey),
      hpkeSecretKey: toB64url(secretKey),
      delivery,
    };
  });
  return {
    about: ABOUT,
    generator: "packages/app-core/src/lib/quorum/recovery-fixture.test.ts",
    ownerPublicKey,
    bundle: created.bundle,
    payload,
    payloadText: JSON.stringify(payload),
    quorum: QUORUM,
    guardians,
  };
}

async function freshFixture(): Promise<Fixture> {
  const owner = generateOwnerKeys();
  const keyed = keyedGuardians();
  const created = await createCircle({
    draft: draftOf(keyed),
    owner,
    payload: PAYLOAD,
    now: NOW,
  });
  return fixtureOf(owner.publicKey, created, keyed);
}

function readFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

const mnemonicsOf = (fixture: Fixture, ids: readonly string[]) =>
  ids.map((id) => fixture.guardians.find((g) => g.id === id)?.mnemonic ?? "");

describe("the committed recovery fixture (spec/conformance/quorum-recovery-fixture.json)", () => {
  it.skipIf(process.env.UPDATE_QUORUM_RECOVERY_FIXTURE !== "1")(
    "is rewritten when asked to",
    async () => {
      writeFileSync(
        FIXTURE,
        `${JSON.stringify(await freshFixture(), null, 2)}\n`,
      );
    },
  );

  it("says its keys are test-only and is the bundle shape circle.ts writes", () => {
    const fixture = readFixture();
    expect(fixture.about).toMatch(/^Test-only keys/);
    expect(RecoveryBundleSchema.parse(fixture.bundle)).toEqual(fixture.bundle);
  });

  it("carries a policy the owner signed, committing to each guardian's share", () => {
    const fixture = readFixture();
    const { policy } = verifySignedPolicy(
      fixture.bundle.signedPolicy,
      fixture.ownerPublicKey,
    );
    expect(policy.epoch).toBe(1);
    expect(Object.keys(policy.shareCommitments).sort()).toEqual(
      fixture.guardians.map((g) => g.id).sort(),
    );
    for (const g of fixture.guardians) {
      expect(shareCommitment(policy.circleId, g.id, g.mnemonic)).toBe(
        policy.shareCommitments[g.id],
      );
    }
  });

  it("delivers each share by HPKE to the guardian's own key", () => {
    for (const g of readFixture().guardians) {
      expect(mnemonicOf(g.delivery, fromB64url(g.hpkeSecretKey))).toBe(
        g.mnemonic,
      );
    }
  });

  it("recombines to a key that opens the bundle to the payload", async () => {
    const fixture = readFixture();
    const secret = await combineMnemonics(
      mnemonicsOf(fixture, fixture.quorum),
      { maxIterationExponent: MAX_RECOVERY_EXPONENT },
    );
    const opened = openBundle(fixture.bundle, secret);
    expect(opened).toEqual(fixture.payload);
    expect(JSON.stringify(opened)).toBe(fixture.payloadText);
  });

  it("does not recombine from less than a quorum", async () => {
    const fixture = readFixture();
    for (const ids of [
      ["ada", "cy"],
      ["ada", "ben", "cy"],
      ["ada", "dee"],
    ]) {
      await expect(
        combineMnemonics(mnemonicsOf(fixture, ids)),
      ).rejects.toThrow();
    }
  });
});

const dir = process.env.OPENSESAME_QUORUM_INTEROP_DIR;
const phase = process.env.OPENSESAME_QUORUM_INTEROP_PHASE;
const RELEASE_DIGEST = `sha256:${"ab".repeat(32)}`;

type TsOut = Fixture &
  Readonly<{
    releaseDigest: string;
    recipient: Readonly<{ publicKey: string; secretKey: string }>;
    /** The same circle one epoch later, so the native reader meets `supersedes`. */
    epoch2: Fixture;
  }>;

type RustOut = Readonly<{
  bundle: RecoveryBundle;
  payload: Json;
  mnemonics: readonly string[];
  releases: readonly Readonly<{
    guardianId: string;
    enc: string;
    ciphertext: string;
  }>[];
}>;

describe.skipIf(!dir || phase !== "produce")(
  "interop 1/2: TypeScript writes a circle for the native reader",
  () => {
    it("writes ts-out.json", async () => {
      const owner = generateOwnerKeys();
      const keyed = keyedGuardians();
      const draft = draftOf(keyed);
      const first = await createCircle({
        draft,
        owner,
        payload: PAYLOAD,
        now: NOW,
      });
      const later = payloadWith("epoch two");
      const second = await assembleCircle({
        draft,
        owner,
        payload: later,
        now: NOW,
        succession: {
          epoch: 2,
          supersedes: { epoch: 1, digest: first.signedPolicy.digest },
        },
      });
      const recipient = generateKeyPair();
      const out: TsOut = {
        ...fixtureOf(owner.publicKey, first, keyed),
        releaseDigest: RELEASE_DIGEST,
        recipient: {
          publicKey: toB64url(recipient.publicKey),
          secretKey: toB64url(recipient.secretKey),
        },
        epoch2: fixtureOf(owner.publicKey, second, keyed, later),
      };
      writeFileSync(join(dir ?? "", "ts-out.json"), JSON.stringify(out));
    });
  },
);

describe.skipIf(!dir || phase !== "consume")(
  "interop 2/2: TypeScript opens what the native reader wrote",
  () => {
    const read = <T>(name: string): T =>
      JSON.parse(readFileSync(join(dir ?? "", name), "utf8"));

    it("opens a native bundle under the TypeScript policy with natively made shares", async () => {
      const out = read<RustOut>("rust-out.json");
      const ts = read<TsOut>("ts-out.json");
      expect(out.bundle.signedPolicy).toEqual(ts.bundle.signedPolicy);
      const secret = await combineMnemonics(out.mnemonics, {
        maxIterationExponent: MAX_RECOVERY_EXPONENT,
      });
      expect(openBundle(out.bundle, secret)).toEqual(out.payload);
    });

    it("opens the releases the native reader sealed to the recipient", () => {
      const out = read<RustOut>("rust-out.json");
      const ts = read<TsOut>("ts-out.json");
      expect(out.releases).toHaveLength(ts.guardians.length);
      for (const release of out.releases) {
        const mnemonic = utf8Text(
          openBase({
            recipientSecretKey: fromB64url(ts.recipient.secretKey),
            enc: fromB64url(release.enc),
            info: utf8Bytes(RELEASE_HPKE_INFO),
            aad: releaseAad(ts.releaseDigest, release.guardianId),
            ciphertext: fromB64url(release.ciphertext),
          }),
        );
        expect(mnemonic).toBe(
          ts.guardians.find((g) => g.id === release.guardianId)?.mnemonic,
        );
      }
    });
  },
);
