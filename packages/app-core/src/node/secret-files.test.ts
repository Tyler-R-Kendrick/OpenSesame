import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node-shared";
import { Effect, FileSystem } from "effect";
import { systemError } from "effect/PlatformError";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeSecretFiles,
  failureOf,
} from "../lib/secret-fs/files.conformance.js";
import { makeFileSystemSecretFiles } from "../lib/secret-fs/filesystem.js";
import { nodeSecretFiles } from "./secret-files.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describeSecretFiles("a directory on disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "secret-files-"));
  return {
    files: await Effect.runPromise(nodeSecretFiles(root)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
});

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "secret-files-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("a directory on disk", () => {
  it("holds each secret as a plain file at the path it was given", async () => {
    const files = await Effect.runPromise(nodeSecretFiles(root));
    await Effect.runPromise(
      files.write("personal/secrets/work/aws.json", bytes("{}")),
    );
    expect(
      readFileSync(join(root, "personal/secrets/work/aws.json"), "utf8"),
    ).toBe("{}");
  });

  it.skipIf(process.platform === "win32")(
    "keeps files and directories owner-only",
    async () => {
      const files = await Effect.runPromise(
        nodeSecretFiles(join(root, "store")),
      );
      await Effect.runPromise(files.write("t/secrets/a.json", bytes("x")));
      expect(statSync(join(root, "store/t/secrets/a.json")).mode & 0o777).toBe(
        0o600,
      );
      expect(statSync(join(root, "store/t/secrets")).mode & 0o777).toBe(0o700);
    },
  );

  it("leaves no staging file behind, and never lists one", async () => {
    const files = await Effect.runPromise(nodeSecretFiles(root));
    await Effect.runPromise(files.write("a.json", bytes("x")));
    writeFileSync(join(root, ".a.json.dead.part"), "half");
    writeFileSync(join(root, ".DS_Store"), "noise");
    expect(await Effect.runPromise(files.list(""))).toEqual(["a.json"]);
    expect(readdirSync(root).sort()).toEqual([
      ".DS_Store",
      ".a.json.dead.part",
      "a.json",
    ]);
  });

  it("keeps the old file whole when the swap fails, and cleans up its staging file", async () => {
    const flaky = await Effect.runPromise(
      Effect.gen(function* () {
        const real = yield* FileSystem.FileSystem;
        const broken = {
          ...real,
          rename: () =>
            Effect.fail(
              systemError({
                _tag: "Busy",
                module: "FileSystem",
                method: "rename",
              }),
            ),
        };
        return yield* makeFileSystemSecretFiles(root).pipe(
          Effect.provideService(FileSystem.FileSystem, broken),
        );
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    const good = await Effect.runPromise(nodeSecretFiles(root));
    await Effect.runPromise(good.write("a.json", bytes("old")));
    const error = await failureOf(flaky.write("a.json", bytes("new")));
    expect(error._tag).toBe("SecretFsUnavailable");
    expect(readFileSync(join(root, "a.json"), "utf8")).toBe("old");
    expect(readdirSync(root)).toEqual(["a.json"]);
  });

  it.skipIf(process.platform === "win32")(
    "will not follow a symlink out of the store",
    async () => {
      const outside = mkdtempSync(join(tmpdir(), "secret-outside-"));
      try {
        writeFileSync(join(outside, "stolen.json"), "secret");
        mkdirSync(join(root, "t"));
        symlinkSync(outside, join(root, "t", "link"));
        symlinkSync(join(outside, "stolen.json"), join(root, "t", "file.json"));
        const files = await Effect.runPromise(nodeSecretFiles(root));
        expect(await failureOf(files.read("t/file.json"))).toMatchObject({
          _tag: "SecretFsRejected",
          kind: "invalid-path",
        });
        expect(
          await failureOf(files.write("t/link/new.json", bytes("x"))),
        ).toMatchObject({ _tag: "SecretFsRejected" });
        expect(await Effect.runPromise(files.list("t"))).toEqual([]);
        expect(readdirSync(outside)).toEqual(["stolen.json"]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it("lets exactly one of two processes create a file, whatever the interleaving", async () => {
    const first = await Effect.runPromise(nodeSecretFiles(root));
    const second = await Effect.runPromise(nodeSecretFiles(root));
    for (let round = 0; round < 8; round += 1) {
      const path = `race-${round}.json`;
      const results = await Promise.all(
        [first, second, first, second].map((files, index) =>
          Effect.runPromiseExit(
            files.write(path, bytes(String(index)), { ifRevision: null }),
          ),
        ),
      );
      expect(results.filter((exit) => exit._tag === "Success")).toHaveLength(1);
    }
  });

  it("leaves no lock file behind", async () => {
    const files = await Effect.runPromise(nodeSecretFiles(root));
    await Effect.runPromise(
      files.write("a.json", bytes("1"), { ifRevision: null }),
    );
    expect(readdirSync(root)).toEqual(["a.json"]);
  });

  it("waits for a writer that holds the lock, and takes over a lock left by a dead one", async () => {
    const files = await Effect.runPromise(nodeSecretFiles(root));
    writeFileSync(join(root, ".a.json.lock"), "");
    setTimeout(() => rmSync(join(root, ".a.json.lock"), { force: true }), 120);
    await Effect.runPromise(
      files.write("a.json", bytes("1"), { ifRevision: null }),
    );
    expect(existsSync(join(root, "a.json"))).toBe(true);

    writeFileSync(join(root, ".b.json.lock"), "");
    const longAgo = new Date(Date.now() - 120_000);
    utimesSync(join(root, ".b.json.lock"), longAgo, longAgo);
    await Effect.runPromise(
      files.write("b.json", bytes("1"), { ifRevision: null }),
    );
    expect(readFileSync(join(root, "b.json"), "utf8")).toBe("1");
    expect(existsSync(join(root, ".b.json.lock"))).toBe(false);
  });
});
