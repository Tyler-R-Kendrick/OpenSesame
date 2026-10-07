/**
 * The one suite every secret file store passes (ADR 0182). A backend that
 * differs from another in any of these answers is a backend the vault would
 * behave differently on, which is the bug this suite exists to prevent.
 */
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import type { SecretFsError } from "./errors.js";
import { revisionOf } from "./files.js";
import type { SecretFiles } from "./files.js";

export type FilesHarness = Readonly<{
  files: SecretFiles;
  cleanup?: () => Promise<void> | void;
}>;

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** Run an effect and hand back its failure, so a test can name what refused. */
export async function failureOf<A>(
  effect: Effect.Effect<A, SecretFsError>,
): Promise<SecretFsError> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag !== "Some") throw new Error("expected a typed failure");
  return failure.value;
}

const BAD_PATHS = [
  "",
  "/abs",
  "a//b",
  "a/../b",
  "..",
  ".hidden",
  "a/.hidden",
  "a\\b",
  "name.part",
  "trailing.",
  "con",
  "a b",
  "a/trailing/",
];

type WithFiles = (body: (files: SecretFiles) => Promise<void>) => Promise<void>;

function readAndWriteCases(withFiles: WithFiles): void {
  it("answers not-found for a file that is not there", () =>
    withFiles(async (files) => {
      const error = await failureOf(files.read("none/here.json"));
      expect(error._tag).toBe("SecretFsNotFound");
    }));

  it("reads back what it wrote, with the content's revision", () =>
    withFiles(async (files) => {
      const revision = await Effect.runPromise(
        files.write("personal/secrets/a.json", bytes("one")),
      );
      expect(revision).toBe(revisionOf(bytes("one")));
      const read = await Effect.runPromise(
        files.read("personal/secrets/a.json"),
      );
      expect(text(read.bytes)).toBe("one");
      expect(read.revision).toBe(revision);
    }));

  it("round-trips every byte value", () =>
    withFiles(async (files) => {
      const all = Uint8Array.from({ length: 256 }, (_, index) => index);
      await Effect.runPromise(files.write("bin.json", all));
      const read = await Effect.runPromise(files.read("bin.json"));
      expect([...read.bytes]).toEqual([...all]);
    }));

  it("replaces a file whole", () =>
    withFiles(async (files) => {
      await Effect.runPromise(files.write("a.json", bytes("long old text")));
      await Effect.runPromise(files.write("a.json", bytes("new")));
      const read = await Effect.runPromise(files.read("a.json"));
      expect(text(read.bytes)).toBe("new");
    }));

  it("does not let a caller edit stored bytes through a returned array", () =>
    withFiles(async (files) => {
      const input = bytes("kept");
      await Effect.runPromise(files.write("a.json", input));
      input.fill(0);
      const first = await Effect.runPromise(files.read("a.json"));
      first.bytes.fill(0);
      const second = await Effect.runPromise(files.read("a.json"));
      expect(text(second.bytes)).toBe("kept");
    }));
}

function revisionCases(withFiles: WithFiles): void {
  it("writes only when the expected revision holds", () =>
    withFiles(async (files) => {
      const first = await Effect.runPromise(
        files.write("a.json", bytes("1"), { ifRevision: null }),
      );
      const stale = await failureOf(
        files.write("a.json", bytes("2"), {
          ifRevision: revisionOf(bytes("x")),
        }),
      );
      expect(stale).toMatchObject({
        _tag: "SecretFsConflict",
        actual: first,
      });
      const again = await failureOf(
        files.write("a.json", bytes("2"), { ifRevision: null }),
      );
      expect(again).toMatchObject({
        _tag: "SecretFsConflict",
        actual: first,
      });
      const missing = await failureOf(
        files.write("b.json", bytes("2"), { ifRevision: first }),
      );
      expect(missing).toMatchObject({
        _tag: "SecretFsConflict",
        actual: null,
      });
      await Effect.runPromise(
        files.write("a.json", bytes("2"), { ifRevision: first }),
      );
      const read = await Effect.runPromise(files.read("a.json"));
      expect(text(read.bytes)).toBe("2");
    }));

  it("lets exactly one of many racing creators win", () =>
    withFiles(async (files) => {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          Effect.runPromiseExit(
            files.write("race.json", bytes(String(index)), {
              ifRevision: null,
            }),
          ),
        ),
      );
      expect(results.filter(Exit.isSuccess)).toHaveLength(1);
    }));
}

function listAndRemoveCases(withFiles: WithFiles): void {
  it("lists files under a prefix, sorted, never a sibling's", () =>
    withFiles(async (files) => {
      for (const path of [
        "b/two.json",
        "a/one.json",
        "a/deep/x.json",
        "ab/no.json",
      ]) {
        await Effect.runPromise(files.write(path, bytes(path)));
      }
      expect(await Effect.runPromise(files.list("a"))).toEqual([
        "a/deep/x.json",
        "a/one.json",
      ]);
      expect(await Effect.runPromise(files.list("a/one.json"))).toEqual([
        "a/one.json",
      ]);
      expect(await Effect.runPromise(files.list(""))).toEqual([
        "a/deep/x.json",
        "a/one.json",
        "ab/no.json",
        "b/two.json",
      ]);
      expect(await Effect.runPromise(files.list("missing"))).toEqual([]);
    }));

  it("removes a file, and removing it again is fine", () =>
    withFiles(async (files) => {
      await Effect.runPromise(files.write("a/one.json", bytes("1")));
      await Effect.runPromise(files.remove("a/one.json"));
      await Effect.runPromise(files.remove("a/one.json"));
      expect((await failureOf(files.read("a/one.json")))._tag).toBe(
        "SecretFsNotFound",
      );
      expect(await Effect.runPromise(files.list(""))).toEqual([]);
    }));
}

function pathCases(withFiles: WithFiles): void {
  it("refuses a path no store can hold, on every operation", () =>
    withFiles(async (files) => {
      for (const path of BAD_PATHS) {
        const refusals = [
          await failureOf(files.read(path)),
          await failureOf(files.write(path, bytes("x"))),
          await failureOf(files.remove(path)),
        ];
        for (const refusal of refusals) {
          expect(refusal).toMatchObject({
            _tag: "SecretFsRejected",
            kind: "invalid-path",
          });
        }
      }
      expect(await Effect.runPromise(files.list(""))).toEqual([]);
    }));
}

export function describeSecretFiles(
  name: string,
  make: () => Promise<FilesHarness>,
): void {
  describe(`${name} keeps the secret file contract`, () => {
    const withFiles: WithFiles = async (body) => {
      const harness = await make();
      try {
        await body(harness.files);
      } finally {
        await harness.cleanup?.();
      }
    };
    readAndWriteCases(withFiles);
    revisionCases(withFiles);
    listAndRemoveCases(withFiles);
    pathCases(withFiles);
  });
}
