/**
 * The two item types, through the real registry, and the engine's records
 * through them: install, fill, project onto the native entry, read back.
 */
import { readFileSync } from "node:fs";
import {
  type FieldValues,
  builtinRegistry,
  fromNativeEntry,
  missingRequired,
  searchTextFor,
  subtitleFor,
  toNativeEntry,
} from "@opensesame/vault-item-types";
import { describe, expect, it } from "vitest";
import { toB64url } from "./bytes.js";
import { PolicyError } from "./policy.js";
import {
  GUARDIAN_SHARE_TYPE,
  TRUSTED_CIRCLE_TYPE,
  circleValues,
  readCircleRecord,
  readShareRecord,
  ruleText,
  shareValues,
} from "./records.js";
import { buildWorld, holdingOf, person } from "./world.test-support.js";

const optional = (name: string) =>
  readFileSync(
    new URL(
      `../../../../../marketplace/item-types/optional/${name}.json`,
      import.meta.url,
    ),
    "utf8",
  );

function install(id: string) {
  const outcome = builtinRegistry().install(optional(id), "vault");
  if (!outcome.ok) throw new Error(outcome.errors.map((e) => e.message).join());
  return outcome.definition;
}

const NAMES = ["Ada", "Ben", "Cy"];
const world = () =>
  buildWorld({
    names: NAMES,
    groups: [{ id: "all", threshold: 2, members: NAMES }],
  });

describe("the item types", () => {
  it("install through the registry as user-installed types, with no secret in a list or a search", () => {
    for (const id of [TRUSTED_CIRCLE_TYPE, GUARDIAN_SHARE_TYPE]) {
      const definition = install(id);
      expect(definition.metadata.id).toBe(id);
      const concealed = new Set(
        definition.spec.sections
          .flatMap((s) => s.fields)
          .filter((f) => f.type === "key-material")
          .map((f) => f.id),
      );
      expect(concealed.size).toBeGreaterThan(0);
      for (const id of [
        ...definition.spec.subtitle,
        ...definition.spec.search,
      ]) {
        expect(concealed.has(id)).toBe(false);
      }
    }
  });

  it("are pinned in the default marketplace", () => {
    const index = JSON.parse(
      readFileSync(
        new URL("../../../../../.opensesame/marketplace.json", import.meta.url),
        "utf8",
      ),
    );
    const paths = index.spec.itemTypes.map((e: { path: string }) => e.path);
    expect(paths).toContain(
      `marketplace/item-types/optional/${TRUSTED_CIRCLE_TYPE}.json`,
    );
    expect(paths).toContain(
      `marketplace/item-types/optional/${GUARDIAN_SHARE_TYPE}.json`,
    );
  });
});

describe("a trusted-circle record", () => {
  it("fills every required field, projects onto a pass entry and reads back", async () => {
    const w = await world();
    const definition = install(TRUSTED_CIRCLE_TYPE);
    const values = circleValues({
      signedPolicy: w.created.signedPolicy,
      ownerSecretKey: w.owner.secretKey,
      state: "armed",
    });
    expect(missingRequired(definition, values)).toEqual([]);
    expect(values.rule).toBe("2 of 3");
    expect(values.guardians).toEqual(NAMES);
    const entry = toNativeEntry(definition, values);
    // Line one of the pass entry is the signing key; the policy is in the trailer.
    expect(entry.secret).toBe(toB64url(w.owner.secretKey));
    expect(entry.trailer).toContain("state: armed");
    const back = fromNativeEntry(definition, entry);
    const record = readCircleRecord(back.values);
    expect(record.signedPolicy.digest).toBe(w.created.signedPolicy.digest);
    expect(record.ownerSecretKey).toEqual(w.owner.secretKey);
  });

  it("keeps the signing key out of the list line and the search text", async () => {
    const w = await world();
    const definition = install(TRUSTED_CIRCLE_TYPE);
    const values = circleValues({
      signedPolicy: w.created.signedPolicy,
      ownerSecretKey: w.owner.secretKey,
      state: "inviting",
    });
    const key = toB64url(w.owner.secretKey);
    expect(subtitleFor(definition, values)).not.toContain(key);
    expect(searchTextFor(definition, values)).not.toContain(key);
    expect(subtitleFor(definition, values)).toContain("2 of 3");
  });

  it("is refused on read if its policy was edited", async () => {
    const w = await world();
    const values = circleValues({
      signedPolicy: w.created.signedPolicy,
      ownerSecretKey: w.owner.secretKey,
      state: "armed",
    });
    const edited: FieldValues = {
      ...values,
      policy: String(values.policy).replace('"epoch":1', '"epoch":2'),
    };
    expect(() => readCircleRecord(edited)).toThrow(PolicyError);
  });

  it("names a two-level rule in words", async () => {
    const two = await buildWorld({
      names: ["F1", "F2", "F3", "P1", "P2"],
      groups: [
        { id: "family", threshold: 2, members: ["F1", "F2", "F3"] },
        { id: "friends", threshold: 2, members: ["P1", "P2"] },
      ],
      groupThreshold: 2,
      skipDelivery: true,
    });
    expect(ruleText(two.created.signedPolicy.policy)).toBe(
      "2 of 2 groups: 2 of 3 family, 2 of 2 friends",
    );
  });
});

describe("a guardian-share record", () => {
  it("keeps the wrapped share, never the share, and reads back under the pinned owner key", async () => {
    const w = await world();
    const ada = person(w, "Ada");
    const definition = install(GUARDIAN_SHARE_TYPE);
    const values = shareValues({
      holding: holdingOf(ada),
      heldFor: "Tyler",
      receivingKey: ada.secrets.hpkeSecretKey,
      state: "held",
    });
    expect(missingRequired(definition, values)).toEqual([]);
    const entry = toNativeEntry(definition, values);
    // Nothing in the whole entry is a SLIP-0039 mnemonic.
    expect(`${entry.secret}\n${entry.trailer}`).not.toMatch(
      /\b(academic|acid|acne)\b.*\b(acquire|acrobat|activity)\b/,
    );
    const back = readShareRecord(fromNativeEntry(definition, entry).values);
    expect(back.holding.wrapped.guardianId).toBe(ada.id);
    expect(back.holding.wrapped.envelopes).toHaveLength(1);
    expect(back.receivingKey).toEqual(ada.secrets.hpkeSecretKey);
  });

  it("is refused on read if its pinned owner key is not the one that signed the policy", async () => {
    const w = await world();
    const ada = person(w, "Ada");
    const values = shareValues({
      holding: holdingOf(ada),
      heldFor: "Tyler",
      state: "held",
    });
    expect(() =>
      readShareRecord({
        ...values,
        ownerKey: toB64url(new Uint8Array(32).fill(5)),
      }),
    ).toThrow(PolicyError);
  });
});
