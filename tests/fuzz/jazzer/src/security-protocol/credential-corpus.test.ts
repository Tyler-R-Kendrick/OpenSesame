import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fuzz as canary } from "../credential_canary_parsers.js";
import { fuzz as observation } from "../credential_observation_parsers.js";
import { writeCredentialCorpus } from "./credential-corpus.js";
import { fuzz as cryptoTarget } from "./credential-observation-native.js";

it("writes bounded private public seeds and exercises actual parser and awaited authentication controls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "credential-native-seeds-"));
  try {
    await writeCredentialCorpus(directory);
    for (const [target, count] of [
      ["canary", 13],
      ["observation", 10],
      ["crypto", 11],
    ] as const) {
      const names = await readdir(join(directory, target));
      expect(names).toHaveLength(count);
      for (const name of names) {
        const path = join(directory, target, name);
        const bytes = await readFile(path);
        expect(bytes.length).toBeLessThanOrEqual(8194);
        if (process.platform !== "win32")
          expect((await stat(path)).mode & 0o777).toBe(0o600);
        if (target === "canary") canary(bytes);
        else if (target === "observation") observation(bytes);
        else await cryptoTarget(bytes);
      }
    }
    await expect(writeCredentialCorpus(directory)).rejects.toMatchObject({
      code: "EEXIST",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
