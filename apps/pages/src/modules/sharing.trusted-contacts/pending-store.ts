/**
 * Ceremonies in flight, sealed in the open vault's tomb (ADR 0186 §10, ADR
 * 0149): an invitation waiting for answers, a pending enrollment, a recovery
 * gathering approvals. They hold secrets (an owner's signing key before the
 * circle exists, a guardian's receiving key, a recipient's key) as base64url
 * inside plain JSON, so each one is a file of the VFS, sealed under the vault
 * key and bound to its tomb and path. Nothing here touches a browser global.
 *
 * A name is a thing too (ADR 0175): the desk's keys (`owner-draft:<circleId>`,
 * `ask:<digest>`) say what a ceremony is and which circle it is for, and a
 * file name is readable on disk. So a file is named by the SHA-256 of its key,
 * and the key travels inside the sealed document, `{ key, value }`. `list`
 * opens the folder's files to learn the keys; the folder is a handful.
 */

import { kvDurability, kvRefresh } from "@opensesame/app-core/lib/kv.js";
import {
  toHex,
  utf8Bytes,
  utf8Text,
} from "@opensesame/app-core/lib/quorum/bytes.js";
import type { Json } from "@opensesame/app-core/lib/quorum/canonical.js";
import {
  DeskError,
  type PendingStore,
} from "@opensesame/app-core/lib/quorum/desk/ports.js";
import {
  INDEX_PATH,
  VfsError,
  deleteFile,
  listDir,
  readFile,
  tombFileKey,
  writeFile,
} from "@opensesame/app-core/lib/vfs.js";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

export const PENDING_DIR = "config/trusted-contacts/pending";

/**
 * A document may be as large as a recovery file the recipient is gathering
 * approvals for; past this a ceremony is refused rather than half kept.
 */
const MAX_BYTES = 16 * 1024 * 1024;

/** The sealed index lists a path per ceremony; it stays far below this. */
const MAX_INDEX_BYTES = 1024 * 1024;

/** A listing opens at most this many files; the real number is a handful. */
const MAX_LISTED = 256;

const NAME = /^[0-9a-f]{64}$/;

const STORED = "a saved ceremony could not be read";

/** The file name of a key: nothing of the key shows in it. */
async function nameOf(key: string): Promise<string> {
  const bytes = utf8Bytes(key);
  if (bytes.length === 0) {
    throw new DeskError(
      "stored",
      "that ceremony cannot be kept on this device",
    );
  }
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

type Document = Readonly<{ key: string; value: Json }>;

/** A sealed document read back: both parts are there, or it is not one of ours. */
function parseDocument(bytes: Uint8Array): Document {
  const found: BoundaryValue = JSON.parse(utf8Text(bytes));
  if (
    !isJsonObject(found) ||
    !isString(found.key) ||
    found.value === undefined
  ) {
    throw new Error("not a pending document");
  }
  return { key: found.key, value: found.value };
}

/**
 * Read what another tab wrote since this one looked. Only where the origin's
 * files are durable: with nothing on disk, memory is all there is and a
 * refresh would take it away (`kvRefresh` drops a key whose file is absent).
 */
async function fresh(tomb: string, path: string, max: number): Promise<void> {
  if (kvDurability() !== "persistent") return;
  await kvRefresh(tombFileKey(tomb, path), max * 2);
}

/** A file's bytes, or `null` where there is none. */
async function open(tomb: string, path: string): Promise<Uint8Array | null> {
  await fresh(tomb, path, MAX_BYTES);
  try {
    return await readFile(tomb, path);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return null;
    throw error;
  }
}

/** The pending store of one open vault. Throws `VfsError("locked")` once it locks. */
export function tombPendingStore(tomb: string): PendingStore {
  return {
    async read(key) {
      const path = `${PENDING_DIR}/${await nameOf(key)}`;
      const bytes = await open(tomb, path);
      if (bytes === null) return undefined;
      let found: Document;
      try {
        found = parseDocument(bytes);
      } catch {
        throw new DeskError("stored", STORED);
      }
      // A file moved under another key's name is not that key's ceremony.
      if (found.key !== key) throw new DeskError("stored", STORED);
      return found.value;
    },

    async write(key, value) {
      const path = `${PENDING_DIR}/${await nameOf(key)}`;
      const bytes = utf8Bytes(JSON.stringify({ key, value }));
      if (bytes.length > MAX_BYTES) {
        throw new DeskError("stored", "that ceremony is too large to keep");
      }
      await writeFile(tomb, path, bytes);
    },

    async remove(key) {
      await deleteFile(tomb, `${PENDING_DIR}/${await nameOf(key)}`);
    },

    async list(prefix) {
      await fresh(tomb, INDEX_PATH, MAX_INDEX_BYTES);
      const paths = (await listDir(tomb, PENDING_DIR))
        .filter((path) => NAME.test(path.slice(PENDING_DIR.length + 1)))
        .slice(0, MAX_LISTED);
      const keys: string[] = [];
      for (const path of paths) {
        const key = await keyIn(tomb, path);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      return keys.sort();
    },
  };
}

/**
 * The key a file holds, or `null` for one that is not ours: it does not read,
 * or its key does not name it. A locked vault is not "not ours".
 */
async function keyIn(tomb: string, path: string): Promise<string | null> {
  try {
    const bytes = await open(tomb, path);
    if (bytes === null) return null;
    const { key } = parseDocument(bytes);
    return (await nameOf(key)) === path.slice(PENDING_DIR.length + 1)
      ? key
      : null;
  } catch (error) {
    if (error instanceof VfsError && error.code === "locked") throw error;
    return null;
  }
}
