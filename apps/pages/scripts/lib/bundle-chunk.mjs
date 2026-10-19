/**
 * Keep the client renderer out of the entry chunk. A hardened profile's
 * largest asset is `main`, and react-dom is what puts it over the 693 KiB
 * ceiling. `onlyExplicitManualChunks` (capability-compose) keeps each name
 * to the files matched here, so the entry imports the renderer instead of
 * carrying its source.
 */
/** @param {string} id */
export function bundleChunk(id) {
  const path = id.split("\\").join("/");
  if (
    path.includes("/node_modules/react-dom/") ||
    path.includes("/node_modules/react/") ||
    path.includes("/node_modules/scheduler/")
  ) {
    return "react-dom";
  }
  if (
    path.includes("/node_modules/react-router/") ||
    path.includes("/node_modules/react-router-dom/")
  ) {
    return "react-router";
  }
  // The device-identity and device-inbox walks import this chunk by the
  // file name `device-identity-host-*.js`. A pure chunk under
  // `experimentalMinChunkSize` is folded into a neighbour, and the name
  // disappears (`assets/undefined`). Manual chunks are not folded.
  if (path.includes("/lib/device-identity-host.ts")) {
    return "device-identity-host";
  }
  return undefined;
}
