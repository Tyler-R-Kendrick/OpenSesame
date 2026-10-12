import {
  type VaultBody,
  createItem,
  emptyBody,
  mintVaultKey,
} from "@opensesame/vault-core";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { SecretFsUnavailable } from "./errors.js";
import type { SecretFsError } from "./errors.js";
import { failureOf } from "./files.conformance.js";
import type { SecretFiles } from "./files.js";
import { makeMemorySecretFiles } from "./memory.js";
import { readProjection } from "./projection-read.js";
import { writeProjection } from "./projection-write.js";
import { EMPTY_PROJECTION } from "./secret-docs.js";

const run = <A>(effect: Effect.Effect<A, SecretFsError>) =>
  Effect.runPromise(effect);

const note = (id: string, name: string) => ({
  ...createItem("note", name),
  id,
});
const bodyOf = (
  rev: number,
  ...items: ReturnType<typeof note>[]
): VaultBody => ({
  ...emptyBody(),
  rev,
  items,
});

describe("writing a vault as documents", () => {
  it("never puts a new secret's document over a file the committed manifest lists for another", async () => {
    const files = makeMemorySecretFiles();
    const key = (await mintVaultKey()).vaultKey;
    const first = await run(
      writeProjection(
        files,
        "t",
        key,
        bodyOf(1, note("a", "x"), note("b", "y")),
        EMPTY_PROJECTION,
      ),
    );
    // A is renamed to z and a new B takes the name x, but the manifest never lands.
    const failing: SecretFiles = {
      ...files,
      write: (path, data, options) =>
        path.endsWith("/vault.json")
          ? Effect.fail(new SecretFsUnavailable({ path, reason: "down" }))
          : files.write(path, data, options),
    };
    const exit = await Effect.runPromiseExit(
      writeProjection(
        failing,
        "t",
        key,
        bodyOf(2, note("a", "z"), note("b", "y"), note("c", "x")),
        first,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    // The committed vault still opens, with A as it was.
    const reopened = await run(readProjection(files, "t", key));
    expect(reopened?.body.items.map((item) => item.name).sort()).toEqual([
      "x",
      "y",
    ]);
    expect(reopened?.body.items.find((item) => item.id === "a")?.name).toBe(
      "x",
    );
  });

  it("will not replace a secret's document another writer has changed since it was read", async () => {
    const files = makeMemorySecretFiles();
    const key = (await mintVaultKey()).vaultKey;
    const ours = await run(
      writeProjection(
        files,
        "t",
        key,
        bodyOf(1, note("a", "x")),
        EMPTY_PROJECTION,
      ),
    );
    // A rival saves a change to the same secret and commits.
    await run(
      writeProjection(
        files,
        "t",
        key,
        bodyOf(2, { ...note("a", "x"), notes: "rival" }),
        ours,
      ),
    );
    // We, still at revision 1 of the manifest, are refused before touching anything.
    const refused = await failureOf(
      writeProjection(
        files,
        "t",
        key,
        bodyOf(2, { ...note("a", "x"), notes: "ours" }),
        ours,
      ),
    );
    expect(refused._tag).toBe("SecretFsConflict");
    const settled = await run(readProjection(files, "t", key));
    expect(settled?.body.items[0]?.notes).toBe("rival");
  });

  it("refuses a document written over in the instant after the manifest check", async () => {
    const inner = makeMemorySecretFiles();
    const key = (await mintVaultKey()).vaultKey;
    const ours = await run(
      writeProjection(
        inner,
        "t",
        key,
        bodyOf(1, note("a", "x")),
        EMPTY_PROJECTION,
      ),
    );
    // The rival lands its document just as ours is being written.
    let raced = false;
    const racing: SecretFiles = {
      ...inner,
      write: (path, data, options) => {
        if (!raced && path.endsWith("/x.note.json")) {
          raced = true;
          return inner
            .write(path, new Uint8Array([1, 2, 3]))
            .pipe(Effect.andThen(inner.write(path, data, options)));
        }
        return inner.write(path, data, options);
      },
    };
    const refused = await failureOf(
      writeProjection(
        racing,
        "t",
        key,
        bodyOf(2, { ...note("a", "x"), notes: "ours" }),
        ours,
      ),
    );
    expect(refused._tag).toBe("SecretFsConflict");
  });
});
