/**
 * The Node host (ADR 0133 §5): what a CLI process gives the core. Local
 * storage is a file under the state directory; session storage lives as long
 * as the process. There is no page, no authenticator, no worker and no
 * service worker, so anything that needs one fails closed.
 */
import { lookup } from "node:dns/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host, RuntimeEnv } from "../host.js";
import { createMemoryStorage } from "../memory-storage.js";
import { fileAtRestKeys } from "./at-rest-key-file.js";
import { createFileStorage } from "./file-storage.js";
import { createNodeLocks } from "./locks.js";
import { nodeOriginFiles } from "./origin-files.js";

export type NodeHostOptions = Readonly<{
  /** Where local storage persists; defaults to `$OPENSESAME_STATE_DIR`. */
  stateDir?: string;
  env?: Partial<RuntimeEnv>;
}>;

export function defaultStateDir(): string {
  return (
    process.env.OPENSESAME_STATE_DIR ??
    join(homedir(), ".local", "state", "opensesame")
  );
}

async function lookupPeerHost(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export function createNodeHost(options: NodeHostOptions = {}): Host {
  const stateDir = options.stateDir ?? defaultStateDir();
  return {
    env: { BASE_URL: "/", DEV: false, ...options.env },
    storage: {
      local: createFileStorage(join(stateDir, "local-storage.json")),
      session: createMemoryStorage(),
    },
    locks: createNodeLocks(join(stateDir, "locks")),
    originFiles: nodeOriginFiles(join(stateDir, "origin-files")),
    atRestKeys: fileAtRestKeys(join(stateDir, "at-rest.key")),
    environment: {
      online: true,
      onOnlineChange: () => () => {},
      userAgent: `node/${process.versions.node}`,
      userActivated: false,
      workers: { dedicated: false, shared: false, service: false },
    },
    peerDns: { lookup: lookupPeerHost },
  };
}
