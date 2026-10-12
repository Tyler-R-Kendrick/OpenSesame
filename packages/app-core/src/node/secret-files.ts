/**
 * The secret file store on a directory of the host's own disk (ADR 0182): the
 * Node half of the store the CLI uses. The store itself is written over
 * Effect's `FileSystem` service in `lib/secret-fs/filesystem.ts`; this file
 * only supplies the service Node provides.
 */
import { NodeFileSystem } from "@effect/platform-node-shared";
import { Effect } from "effect";
import type { SecretFiles } from "../lib/secret-fs/files.js";
import { makeFileSystemSecretFiles } from "../lib/secret-fs/filesystem.js";

export function nodeSecretFiles(root: string): Effect.Effect<SecretFiles> {
  return makeFileSystemSecretFiles(root).pipe(
    Effect.provide(NodeFileSystem.layer),
  );
}
