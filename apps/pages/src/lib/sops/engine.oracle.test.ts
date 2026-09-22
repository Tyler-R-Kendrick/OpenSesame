/** @vitest-environment node */
/**
 * The pinned upstream oracle, executed: browser → upstream, browser edits
 * of upstream files, upstream edits of browser files, and threshold
 * documents both ways (SB-003, SB-004, SB-005, SB-012, SB-026, SB-037,
 * SB-039, SB-080).
 *
 * These cases are skipped unless the verified binary is present;
 * `pnpm verify:sops-conformance` provisions it and reports an incomplete
 * result rather than a pass when it cannot.
 */
import { describe, expect, it } from "vitest";
import {
  provisionOracle,
  runSops,
} from "../../../scripts/sops-oracle/oracle.mjs";
import { SopsError } from "./errors.js";
import { NEVER, TestSession, newIdentity } from "./test-support.js";
import {
  type FixtureCase,
  looseDocuments,
  readFixture,
  readIdentities,
  readManifest,
} from "./test/fixtures.js";

const manifest = readManifest();
const ids = readIdentities();
const identitiesFor = (fixture: FixtureCase) =>
  fixture.identities.map((index) => ids[index]?.identity ?? "");
const NOW = new Date("2026-09-22T00:00:00Z");

const oracle = provisionOracle({ allowDownload: false });
const bin = oracle.bin;

describe.skipIf(!bin)(
  "pinned upstream oracle: both directions and both edit directions",
  () => {
    const plainCases = manifest.cases.filter(
      (fixture) => fixture.config === null,
    );

    for (const fixture of plainCases) {
      it(`SB-003: browser-encrypted ${fixture.name} decrypts upstream to the same document`, async () => {
        const session = new TestSession();
        const plain = readFixture(fixture.plain);
        const recipients = fixture.identities.map(
          (index) => ids[index]?.recipient ?? "",
        );
        const policy = policyFromArgs(fixture.args);
        const { plan, permit } = await session.plan(
          fixture.format,
          [recipients],
          { policy },
        );
        const cipher = await session.engine.encryptNew(plain, {
          plan,
          permit,
          signal: NEVER,
          now: NOW,
        });
        const result = runSops(bin ?? "", {
          args: [
            "--decrypt",
            "--input-type",
            fixture.format,
            "--output-type",
            fixture.format,
          ],
          input: cipher,
          inputName: `doc.${fixture.format}`,
          identities: identitiesFor(fixture),
        });
        expect(result.status, result.stderr).toBe(0);
        expect(looseDocuments(result.stdout, fixture.format)).toEqual(
          looseDocuments(
            readFixture(`${fixture.name}.dec.${fixture.format}`),
            fixture.format,
          ),
        );
      });
    }

    it("SB-004: an upstream file edited in the browser decrypts upstream with the edit and its policy intact", async () => {
      const session = new TestSession();
      const fixture = manifest.cases.find(
        (item) => item.name === "two-recipients",
      ) as FixtureCase;
      const cipher = readFixture("two-recipients.enc.yaml");
      const opened = await session.engine.open(cipher, "yaml", {
        identities: [ids[1]?.identity ?? ""],
        permit: session.permit(),
        signal: NEVER,
      });
      const edited = opened.plaintext
        .replace("hello: world", "hello: edited in the browser")
        .replace("count: 2", "count: 3");
      const saved = await session.engine.saveEdited(
        opened.handle,
        edited,
        session.permit(),
        NEVER,
        NOW,
      );
      for (const index of fixture.identities) {
        const result = runSops(bin ?? "", {
          args: ["--decrypt"],
          input: saved,
          inputName: "doc.yaml",
          identities: [ids[index]?.identity ?? ""],
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toMatch(/hello: edited in the browser/u);
        expect(result.stdout).toMatch(/count: 3/u);
        expect(result.stdout).toMatch(/note_unencrypted: visible/u);
      }
      expect(saved).toMatch(/unencrypted_suffix: _unencrypted/u);
    });

    it("SB-005: a browser file edited upstream with `--set` opens in the browser", async () => {
      const session = new TestSession();
      const id = await newIdentity();
      const { plan, permit } = await session.plan("yaml", [[id.recipient]]);
      const cipher = await session.engine.encryptNew(
        "hello: world\ncount: 2\nnested:\n  k: v\n",
        { plan, permit, signal: NEVER, now: NOW },
      );
      const edited = runSops(bin ?? "", {
        args: ["--set", '["nested"]["k"] "set by sops"'],
        input: cipher,
        inputName: "doc.yaml",
        identities: [id.identity],
        readBack: true,
      });
      expect(edited.status, edited.stderr).toBe(0);
      expect(edited.file).not.toBeNull();
      expect(edited.file).not.toBe(cipher);
      const opened = await session.engine.open(edited.file ?? "", "yaml", {
        identities: [id.identity],
        permit: session.permit(),
        signal: NEVER,
      });
      expect(opened.plaintext).toBe(
        "hello: world\ncount: 2\nnested:\n  k: set by sops\n",
      );
    });

    it("SB-037/039: a browser 2-of-3 document opens upstream with two groups and not with one", async () => {
      const session = new TestSession();
      const three = [
        await newIdentity(),
        await newIdentity(),
        await newIdentity(),
      ];
      const { plan, permit } = await session.plan(
        "yaml",
        three.map((entry) => [entry.recipient]),
        { shamirThreshold: 2 },
      );
      const cipher = await session.engine.encryptNew("hello: world\n", {
        plan,
        permit,
        signal: NEVER,
        now: NOW,
      });
      const two = runSops(bin ?? "", {
        args: ["--decrypt"],
        input: cipher,
        inputName: "doc.yaml",
        identities: [three[0]?.identity ?? "", three[2]?.identity ?? ""],
      });
      expect(two.status, two.stderr).toBe(0);
      expect(two.stdout).toBe("hello: world\n");
      const one = runSops(bin ?? "", {
        args: ["--decrypt"],
        input: cipher,
        inputName: "doc.yaml",
        identities: [three[1]?.identity ?? ""],
      });
      expect(one.status).not.toBe(0);
    });

    it("SB-012/026/045: timestamps, mac_only_encrypted, and selectors written by the browser read upstream", async () => {
      const session = new TestSession();
      const id = await newIdentity();
      const plain =
        "when: 2001-12-14T21:59:43.1-05:00\nsecret: s\npublic_unencrypted: p\n# sops:enc\nmarked: m\nplain: q\n";
      const { plan, permit } = await session.plan("yaml", [[id.recipient]], {
        policy: {
          unencryptedSuffix: "",
          encryptedCommentRegex: "sops:enc",
          macOnlyEncrypted: true,
        },
      });
      const cipher = await session.engine.encryptNew(plain, {
        plan,
        permit,
        signal: NEVER,
        now: NOW,
      });
      expect(cipher).toMatch(/marked: ENC\[/u);
      expect(cipher).toMatch(/plain: q/u);
      const result = runSops(bin ?? "", {
        args: ["--decrypt"],
        input: cipher,
        inputName: "doc.yaml",
        identities: [id.identity],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(looseDocuments(result.stdout, "yaml")).toEqual(
        looseDocuments(plain, "yaml"),
      );
      const stamped = await session.plan("yaml", [[id.recipient]]);
      const cipher2 = await session.engine.encryptNew(
        plain.split("\n").slice(0, 1).join("\n").concat("\n"),
        { plan: stamped.plan, permit: stamped.permit, signal: NEVER, now: NOW },
      );
      expect(cipher2).toMatch(/type:time\]/u);
      const result2 = runSops(bin ?? "", {
        args: ["--decrypt"],
        input: cipher2,
        inputName: "doc.yaml",
        identities: [id.identity],
      });
      expect(result2.stdout).toBe("when: 2001-12-14T21:59:43.1-05:00\n");
    });

    it("SB-080: the oracle rejects a browser file whose MAC no longer matches", async () => {
      const session = new TestSession();
      const id = await newIdentity();
      const { plan, permit } = await session.plan("yaml", [[id.recipient]]);
      const cipher = await session.engine.encryptNew(
        "a: one\nb_unencrypted: two\n",
        { plan, permit, signal: NEVER, now: NOW },
      );
      const tampered = cipher.replace(
        "b_unencrypted: two",
        "b_unencrypted: three",
      );
      const result = runSops(bin ?? "", {
        args: ["--decrypt"],
        input: tampered,
        inputName: "doc.yaml",
        identities: [id.identity],
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/MAC mismatch/u);
      await expect(
        session.engine.open(tampered, "yaml", {
          identities: [id.identity],
          permit: session.permit(),
          signal: NEVER,
        }),
      ).rejects.toBeInstanceOf(SopsError);
    });
  },
);

function policyFromArgs(args: string[]) {
  const policy: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1] ?? "";
    switch (flag) {
      case "--unencrypted-suffix":
        policy.unencryptedSuffix = value;
        break;
      case "--encrypted-suffix":
        policy.unencryptedSuffix = "";
        policy.encryptedSuffix = value;
        break;
      case "--encrypted-regex":
        policy.unencryptedSuffix = "";
        policy.encryptedRegex = value;
        break;
      case "--unencrypted-regex":
        policy.unencryptedSuffix = "";
        policy.unencryptedRegex = value;
        break;
      case "--encrypted-comment-regex":
        policy.unencryptedSuffix = "";
        policy.encryptedCommentRegex = value;
        break;
      case "--unencrypted-comment-regex":
        policy.unencryptedSuffix = "";
        policy.unencryptedCommentRegex = value;
        break;
      case "--mac-only-encrypted":
        policy.macOnlyEncrypted = true;
        break;
      default:
        break;
    }
  }
  return policy;
}
