import type { BoundaryValue } from "@opensesame/os-domain";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { withLocalDirectoryLock } from "./local-directory.js";
import { localSubjectUnderLock } from "./local-subject-store.js";
import {
  lockAllTombs,
  readFile,
  unlockTomb,
  vfsSeams,
  writeFile,
} from "./vfs.js";

const principal = "local_00000000-0000-4000-8000-000000000001";
const app = "local_00000000-0000-4000-8000-000000000002";
const other = "local_00000000-0000-4000-8000-000000000003";
const path = "config/identity-subjects";
let tomb: string;
beforeEach(async () => {
  tomb = `subjects-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
});
afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function subject(person = principal, application = app, vault = tomb) {
  return withLocalDirectoryLock(vault, () =>
    localSubjectUnderLock(vault, person, application),
  );
}
async function seed(subjects: BoundaryValue, version = 1) {
  const bytes = new TextEncoder().encode(JSON.stringify({ version, subjects }));
  await writeFile(tomb, path, bytes);
  return bytes;
}

it("serializes first use and retains one random subject per principal and app", async () => {
  const subjects = await Promise.all(
    Array.from({ length: 10 }, () => subject()),
  );
  expect(new Set(subjects).size).toBe(1);
  expect(subjects[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await subject(other)).not.toBe(subjects[0]);
  expect(await subject(principal, other)).not.toBe(subjects[0]);
  const secondTomb = `${tomb}-other`;
  unlockTomb(secondTomb, (await mintVaultKey()).vaultKey);
  expect(await subject(principal, app, secondTomb)).not.toBe(subjects[0]);
});

it.each(
  [
    [{ principalId: principal, applicationId: app, subject: principal }],
    [
      {
        principalId: principal,
        applicationId: app,
        subject: "x".repeat(43),
        extra: "bad",
      },
    ],
    [
      { principalId: principal, applicationId: app, subject: "x".repeat(43) },
      { principalId: principal, applicationId: app, subject: "y".repeat(43) },
    ],
    [
      { principalId: principal, applicationId: app, subject: "x".repeat(43) },
      { principalId: other, applicationId: app, subject: "x".repeat(43) },
    ],
    null,
  ].map((rows) => [rows]),
)(
  "refuses malformed or ambiguous mappings without replacing them: %j",
  async (rows) => {
    const before = await seed(rows);
    await expect(subject()).rejects.toThrow();
    expect(await readFile(tomb, path)).toEqual(before);
  },
);

it("does not overwrite an unsupported version", async () => {
  const before = await seed([], 2);
  await expect(subject()).rejects.toThrow();
  expect(await readFile(tomb, path)).toEqual(before);
});

it("reuses existing mappings at capacity, and refuses new ones without evicting identities", async () => {
  const rows = Array.from({ length: 4096 }, (_, index) => ({
    principalId: principal,
    applicationId: `local_${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000002`,
    subject: index.toString().padStart(43, "s"),
  }));
  const before = await seed(rows);
  expect(await subject(principal, rows[0].applicationId)).toBe(rows[0].subject);
  await expect(subject(principal, other)).rejects.toThrow();
  expect(await readFile(tomb, path)).toEqual(before);
});

it("does not return a subject when its encrypted write fails", async () => {
  vi.spyOn(vfsSeams, "writeRaw").mockRejectedValue(new Error("Storage failed"));
  await expect(subject()).rejects.toThrow("Storage failed");
});
