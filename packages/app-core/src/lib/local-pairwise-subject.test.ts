import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, expect, it } from "vitest";
import { localPairwiseSubjectInDirectoryFence } from "./local-pairwise-subject.js";
import { lockAllTombs, lockTomb, unlockTomb, writeFile } from "./vfs.js";

const person = "local_00000000-0000-4000-8000-000000000001";
const app = "local_00000000-0000-4000-8000-000000000002";
const otherApp = "local_00000000-0000-4000-8000-000000000003";

afterEach(lockAllTombs);

it("keeps a stable opaque subject across grants and vault reload, isolated per application and person", async () => {
  const tomb = `pairwise-${crypto.randomUUID()}`;
  const { vaultKey } = await mintVaultKey();
  unlockTomb(tomb, vaultKey);
  const first = await localPairwiseSubjectInDirectoryFence(tomb, person, app);
  const second = await localPairwiseSubjectInDirectoryFence(
    tomb,
    person,
    otherApp,
  );
  const otherPerson = await localPairwiseSubjectInDirectoryFence(
    tomb,
    otherApp,
    app,
  );
  expect(new Set([first, second, otherPerson]).size).toBe(3);
  expect(first).not.toContain(person);
  expect(first).not.toBe(person);
  lockTomb(tomb);
  await expect(
    localPairwiseSubjectInDirectoryFence(tomb, person, app),
  ).rejects.toThrow();
  unlockTomb(tomb, vaultKey);
  expect(await localPairwiseSubjectInDirectoryFence(tomb, person, app)).toBe(
    first,
  );
});

it("fails closed on a corrupt mapping instead of returning or reminting a canonical subject", async () => {
  const tomb = `pairwise-corrupt-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  await writeFile(
    tomb,
    "config/identity-pairwise-subjects",
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        subjects: [
          { principalId: person, applicationId: app, subject: person },
        ],
      }),
    ),
  );
  await expect(
    localPairwiseSubjectInDirectoryFence(tomb, person, app),
  ).rejects.toThrow(/unavailable/);
});
