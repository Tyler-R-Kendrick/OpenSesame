/**
 * The Node host (ADR 0133 §5): what a CLI process gives the core. Local
 * storage is a file under the state directory; session storage lives as long
 * as the process. There is no page, no authenticator, no worker and no
 * service worker, so anything that needs one fails closed.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host, RuntimeEnv } from "../host.js";
import { createMemoryStorage } from "../memory-storage.js";
import { createFileStorage } from "./file-storage.js";

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

export function createNodeHost(options: NodeHostOptions = {}): Host {
  const stateDir = options.stateDir ?? defaultStateDir();
  return {
    env: { BASE_URL: "/", DEV: false, ...options.env },
    storage: {
      local: createFileStorage(join(stateDir, "local-storage.json")),
      session: createMemoryStorage(),
    },
    environment: {
      online: true,
      onOnlineChange: () => () => {},
      userAgent: `node/${process.versions.node}`,
      userActivated: false,
      workers: { dedicated: false, shared: false, service: false },
    },
  };
}
