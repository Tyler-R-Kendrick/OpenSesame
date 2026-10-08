/** The ordinary VFS initializes its unchanged singleton without reading ports at import. */
import { openJson, sealJson } from "@opensesame/vault-core";
import { kvDeleteDurable, kvGet, kvRefresh, kvSetDurable } from "./kv.js";
import { type VfsSeams, vfsSeams as installed } from "./vfs-seams-state.js";
export type { VfsSeams } from "./vfs-seams-state.js";
export const vfsSeams: VfsSeams = Object.assign(installed, {
  readRaw: kvGet,
  writeRaw: kvSetDurable,
  deleteRaw: kvDeleteDurable,
  refreshRaw: kvRefresh,
  seal: sealJson,
  open: openJson,
});
