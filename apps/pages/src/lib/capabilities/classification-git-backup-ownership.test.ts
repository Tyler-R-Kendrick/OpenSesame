import { expect, it } from "vitest";
import { classify } from "./classification.js";

it.each([
  "vault-backup-write-owner",
  "vault-backup-readonly",
  "vault-backup-forge",
  "git-backup-credentials",
  "gitlab-backup-protocol",
  "gitlab-backup-target",
])(
  "keeps %s and its owning tests in the actual always-on backup capability",
  (stem) => {
    for (const suffix of [".ts", ".test.ts"])
      expect(classify(`src/lib/${stem}${suffix}`)).toMatchObject({
        pattern: `src/lib/${stem}`,
        classification: "core",
        capability: "backup.git-remote",
      });
    expect(classify(`src/lib/${stem}s.ts`)).toBeNull();
  },
);

it("covers concrete forge owner/recovery helpers without admitting an arbitrary forge family", () => {
  for (const path of [
    "src/lib/vault-backup-forge-owner.ts",
    "src/lib/vault-backup-forge-recovery.test.ts",
  ])
    expect(classify(path), path).toMatchObject({
      classification: "core",
      capability: "backup.git-remote",
    });
  for (const path of [
    "src/lib/vault-backup-unowned.ts",
    "src/lib/gitlab-remote-runtime.ts",
    "src/lib/git-backup-provider.ts",
  ])
    expect(classify(path), path).toBeNull();
});

it.each([
  "native-base64.ts",
  "native-response-json.ts",
  "secret-backends/types.ts",
])("shares only the pure common implementation %s", (path) => {
  expect(classify(`src/lib/${path}`)).toMatchObject({
    pattern: `src/lib/${path}`,
    classification: "shared",
    capability: null,
  });
});

it("retains optional credential, transport, target verification and provider authority", () => {
  for (const path of [
    "native-api-auth.ts",
    "native-api-http.ts",
    "native-gitlab-backup-target.ts",
    "native-gitlab-backup.ts",
    "native-base64-runtime.ts",
    "native-response-json-owner.ts",
    "secret-backends/factory.ts",
    "secret-backends/types-runtime.ts",
  ])
    expect(classify(`src/lib/${path}`), path).toMatchObject({
      classification: "optional",
      capability: "connectors.external",
    });
});
