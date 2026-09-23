/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { parseSopsConfig, planFromRule, selectCreationRule } from "./config.js";
import { readIdentities } from "./test/fixtures.js";

const ids = readIdentities();
const r = (index: number) => ids[index]?.recipient ?? "";

describe("SB-044/048 .sops.yaml is explicit, bounded, untrusted policy", () => {
  it("picks the first matching creation rule relative to the config's directory", () => {
    const config = parseSopsConfig(
      `creation_rules:\n  - path_regex: ^prod/.*\\.yaml$\n    age: ${r(0)}\n  - path_regex: ^dev/\n    age: ${r(1)}\n  - age: ${r(2)}\n`,
    );
    expect(config.rules.length).toBe(3);
    const prod = selectCreationRule(config, "prod/app.yaml");
    expect(prod.groups[0]?.[0]).toMatchObject({ kind: "age", recipient: r(0) });
    expect(
      selectCreationRule(config, "dev/app.yaml").groups[0]?.[0],
    ).toMatchObject({ recipient: r(1) });
    // A path outside both prefixes falls to the catch-all rule.
    expect(
      selectCreationRule(config, "other/app.yaml").groups[0]?.[0],
    ).toMatchObject({ recipient: r(2) });
    // The path is taken relative to the config's own directory.
    expect(
      selectCreationRule(config, "repo/prod/app.yaml", "repo").groups[0]?.[0],
    ).toMatchObject({ recipient: r(0) });
  });

  it("reads age as a string, a comma list, or a sequence, and builds key groups", () => {
    const inline = parseSopsConfig(
      `creation_rules:\n  - age: "${r(0)},${r(1)}"\n`,
    );
    expect(selectCreationRule(inline, "a.yaml").groups[0]?.length).toBe(2);
    const list = parseSopsConfig(
      `creation_rules:\n  - age:\n      - ${r(0)}\n      - ${r(1)}\n`,
    );
    expect(selectCreationRule(list, "a.yaml").groups[0]?.length).toBe(2);
    const groups = parseSopsConfig(
      `creation_rules:\n  - shamir_threshold: 2\n    key_groups:\n      - age:\n          - ${r(0)}\n      - age:\n          - ${r(1)}\n      - age:\n          - ${r(2)}\n`,
    );
    const rule = selectCreationRule(groups, "a.yaml");
    expect(rule.groups.length).toBe(3);
    expect(rule.shamirThreshold).toBe(2);
    const plan = planFromRule(rule, "yaml");
    expect(plan.shamirThreshold).toBe(2);
    expect(plan.groups.length).toBe(3);
  });

  it("carries the selection policy and refuses two selectors in one rule", () => {
    const config = parseSopsConfig(
      `creation_rules:\n  - age: ${r(0)}\n    encrypted_regex: ^(pw|token)$\n`,
    );
    const rule = selectCreationRule(config, "a.yaml");
    expect(rule.policy.encryptedRegex).toBe("^(pw|token)$");
    expect(rule.policy.unencryptedSuffix).toBe("");
    expect(() => planFromRule(rule, "yaml")).not.toThrow();
    const both = parseSopsConfig(
      `creation_rules:\n  - age: ${r(0)}\n    encrypted_regex: ^a$\n    unencrypted_suffix: _clear\n`,
    );
    expect(() =>
      planFromRule(selectCreationRule(both, "a.yaml"), "yaml"),
    ).toThrow(/only one/iu);
    const defaulted = parseSopsConfig(`creation_rules:\n  - age: ${r(0)}\n`);
    expect(
      selectCreationRule(defaulted, "a.yaml").policy.unencryptedSuffix,
    ).toBe("_unencrypted");
  });

  it("refuses an invalid recipient rather than silently dropping it (SB-031)", () => {
    expect(() =>
      parseSopsConfig(
        `creation_rules:\n  - age: "${r(0)},age1notarealrecipient"\n`,
      ),
    ).toThrow(/recipient/u);
  });

  it("never honours an executable, publish, plugin, or key-service directive (SB-048)", () => {
    for (const config of [
      "creation_rules:\n  - age: x\n    exec: rm -rf /\n",
      "destination_rules:\n  - s3_bucket: attacker\n",
      "creation_rules:\n  - age: x\n    key_service: tcp://attacker:5000\n",
      "creation_rules:\n  - age: x\n    publish: https://attacker.example\n",
      "creation_rules:\n  - age: x\n    plugin: ./evil.so\n",
    ]) {
      expect(() => parseSopsConfig(config), config).toThrow(
        /does not honor|recipient/u,
      );
    }
  });

  it("reports a rule naming cloud master keys as unsupported instead of encrypting to fewer recipients", () => {
    const config = parseSopsConfig(
      `creation_rules:\n  - age: ${r(0)}\n    kms: arn:aws:kms:us-east-1:111122223333:key/abcd\n`,
    );
    const rule = selectCreationRule(config, "a.yaml");
    expect(rule.unsupported).toContain("kms");
    expect(() => planFromRule(rule, "yaml")).toThrow(/cannot wrap/u);
  });

  it("bounds the config and refuses a document path that matches no rule", () => {
    const config = parseSopsConfig(
      `creation_rules:\n  - path_regex: ^only/\n    age: ${r(0)}\n`,
    );
    expect(() => selectCreationRule(config, "elsewhere.yaml")).toThrow(
      /No creation rule/u,
    );
    expect(() => parseSopsConfig("a: 1\n")).toThrow(/does not honor/u);
    expect(() => parseSopsConfig("creation_rules: {}\n")).toThrow(
      /must be a list/u,
    );
    expect(() =>
      parseSopsConfig(
        `creation_rules:\n  - path_regex: "(?i)x"\n    age: ${r(0)}\n`,
      ),
    ).toThrow(/does not implement/u);
    expect(() => parseSopsConfig("x".repeat(300_000))).toThrow(/budget/u);
  });
});
