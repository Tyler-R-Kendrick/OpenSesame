/** @vitest-environment node */
/**
 * Key groups, thresholds, and the selector families — the cases that need
 * several identities and several documents, kept out of `engine.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { parseJsonTree } from "./json-codec.js";
import { entry, scalarText } from "./model.js";
import {
  NEVER,
  TestSession,
  newIdentities,
  newIdentity,
} from "./test-support.js";

const NOW = new Date("2026-09-21T12:00:00Z");

async function opened(
  session: TestSession,
  text: string,
  format: "yaml" | "json",
  identities: string[],
) {
  return session.engine.open(text, format, {
    identities,
    permit: session.permit(),
    signal: NEVER,
  });
}

describe("browser SOPS key groups and selectors", () => {
  it("two-of-three age groups: any two open, one alone fails, repeats count once (SB-037, SB-038, SB-041)", async () => {
    const session = new TestSession();
    const at = await newIdentities(4);
    const groups = [
      [at(0).recipient, at(3).recipient],
      [at(1).recipient],
      [at(2).recipient],
    ];
    const { plan, permit } = await session.plan("yaml", groups, {
      shamirThreshold: 2,
    });
    const cipher = await session.engine.encryptNew("hello: world\n", {
      plan,
      permit,
      signal: NEVER,
      now: NOW,
    });
    expect(cipher).toMatch(/shamir_threshold: 2/u);
    expect(cipher).toMatch(/key_groups:/u);
    const inspection = session.engine.inspect(cipher, "yaml");
    expect(inspection.keyGroups.length).toBe(3);
    expect(inspection.requiredGroups).toBe(2);
    const a = await opened(session, cipher, "yaml", [
      at(0).identity,
      at(2).identity,
    ]);
    expect(a.plaintext).toBe("hello: world\n");
    const b = await opened(session, cipher, "yaml", [
      at(1).identity,
      at(2).identity,
    ]);
    expect(b.plaintext).toBe("hello: world\n");
    await expect(
      opened(session, cipher, "yaml", [at(0).identity]),
    ).rejects.toMatchObject({ code: "insufficient_groups" });
    // Two members of the same group are still one group.
    await expect(
      opened(session, cipher, "yaml", [at(0).identity, at(3).identity]),
    ).rejects.toMatchObject({ code: "insufficient_groups" });
    await expect(
      session.plan("yaml", groups, { shamirThreshold: 4 }),
    ).rejects.toMatchObject({ code: "unauthorized_policy" });
    await expect(
      session.plan("yaml", groups, { shamirThreshold: 1 }),
    ).rejects.toMatchObject({ code: "unauthorized_policy" });
  });

  it("same-DEK save keeps every wrapper, including a foreign one it cannot open, and uses fresh nonces (SB-029, SB-042)", async () => {
    const session = new TestSession();
    const id = await newIdentity();
    const { plan, permit } = await session.plan("yaml", [[id.recipient]]);
    const cipher = await session.engine.encryptNew("a: one\nb: two\n", {
      plan,
      permit,
      signal: NEVER,
      now: NOW,
    });
    expect(cipher).toMatch(/\n {2}age:\n/u);
    const withKms = cipher.replace(
      "\n  age:\n",
      '\n  kms:\n    - arn: arn:aws:kms:us-east-1:111122223333:key/00000000-0000-4000-8000-000000000000\n      aws_profile: ""\n      created_at: "2026-09-21T12:00:00Z"\n      enc: AQICAHh\n  age:\n',
    );
    const result = await opened(session, withKms, "yaml", [id.identity]);
    expect(
      result.inspection.keyGroups[0]?.entries.map((entryOf) => entryOf.kind),
    ).toEqual(["kms", "age"]);
    const saved = await session.engine.saveEdited(
      result.handle,
      "a: one\nb: three\n",
      session.permit(),
      NEVER,
      new Date("2026-09-21T13:00:00Z"),
    );
    expect(saved).toMatch(/arn:aws:kms:us-east-1:111122223333/u);
    expect(saved).toMatch(/enc: AQICAHh/u);
    const originalAge =
      /-----BEGIN AGE ENCRYPTED FILE-----[\s\S]*?-----END AGE ENCRYPTED FILE-----/u.exec(
        cipher,
      )?.[0];
    expect(
      originalAge && saved.includes(originalAge.split("\n")[1] ?? ""),
    ).toBe(true);
    const oldA = /a: (ENC\[[^\]]+\])/u.exec(cipher)?.[1];
    expect(oldA && saved.includes(oldA)).toBe(false);
    const reopened = await opened(session, saved, "yaml", [id.identity]);
    expect(reopened.plaintext).toBe("a: one\nb: three\n");
  });

  it("rotation mints a new data key and rewraps every selected recipient (SB-030, SB-043)", async () => {
    const session = new TestSession();
    const id = await newIdentity();
    const next = await newIdentity();
    const first = await session.plan("yaml", [[id.recipient]]);
    const cipher = await session.engine.encryptNew("a: one\n", {
      plan: first.plan,
      permit: first.permit,
      signal: NEVER,
      now: NOW,
    });
    const result = await opened(session, cipher, "yaml", [id.identity]);
    const rotated = await session.plan("yaml", [[next.recipient]]);
    const output = await session.engine.rotate(result.handle, null, {
      plan: rotated.plan,
      permit: rotated.permit,
      signal: NEVER,
      now: NOW,
    });
    await expect(
      opened(session, output, "yaml", [id.identity]),
    ).rejects.toMatchObject({ code: "missing_identity" });
    const reopened = await opened(session, output, "yaml", [next.identity]);
    expect(reopened.plaintext).toBe("a: one\n");
    // An invalid recipient anywhere in the plan fails before output (SB-031).
    expect(() => session.engine.inspect("a: 1\n", "yaml")).not.toThrow();
    await expect(
      session.plan("yaml", [[next.recipient, "age1notarealrecipient"]]),
    ).rejects.toMatchObject({ code: "invalid_recipient" });
  });
});
