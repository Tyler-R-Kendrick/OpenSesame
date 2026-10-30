/**
 * Keep the client renderer out of the entry chunk. A hardened profile's
 * largest asset is `main`, and react-dom is what puts it over the 693 KiB
 * ceiling. `onlyExplicitManualChunks` (capability-compose) keeps each name
 * to the files matched here, so the entry imports the renderer instead of
 * carrying its source.
 */
export function bundleChunk(id) {
  const path = id.split("\\").join("/");
  // Evaluate CSP-safe schema configuration before any imported schema chunks,
  // including hardened profiles that emit no dedicated workers.
  if (path.endsWith("/packages/app-core/src/lib/zod-jitless.ts")) {
    return "schema-csp";
  }
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
  // Curves are shared by lazy features. Hashes also serve bootstrap, so
  // leave all hash modules to Rollup: grouping them with curves would pull
  // the lazy curves onto the first page. Noble v2 hashes live at the package
  // root rather than under /esm/.
  if (
    path.includes("/node_modules/@noble/curves/") &&
    !path.includes("/node_modules/@noble/curves/esm/")
  ) {
    return "noble-crypto";
  }
  // P8-2 peer trust: handshake.ts, webcrypto.ts, and peers.ts are emitted
  // into more than one lazy chunk (the live session graph and the sharing
  // UI). One chunk keeps a single copy. The bootstrap entry already imports
  // the shared b64 helper and the peer-trust database name; those stay put.
  // Folding them in here would pull this chunk onto the first page.
  if (
    path.includes("/lib/peer-trust/handshake.ts") ||
    path.includes("/lib/peer-trust/webcrypto.ts") ||
    path.includes("/lib/peer-trust/peers.ts")
  ) {
    return "peer-trust";
  }
  return undefined;
}
