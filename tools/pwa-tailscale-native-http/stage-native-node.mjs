/** Stage only the reviewed bridge and original-node hook into owned source. */
import { constants, copyFile } from "node:fs/promises";
import { join } from "node:path";

const bridgeNames = [
  "nativehttp_js.go",
  "native-http.mjs",
  "native-http.test.mjs",
  "streaming_js.go",
  "native-http-stream.mjs",
  "native-http-stream.test.mjs",
  "native-http-stream.test-support.mjs",
];
const nodeNames = [
  "nodehttp_js.go",
  "native-node.patch",
  "nodepeer.go",
  "nodepeer_test.go",
  "native-extra-dns.go",
  "native-extra-dns_test.go",
  "native-ssh-keys.go",
  "native-ssh-keys_test.go",
  "nodessh_js.go",
  "derp-custom-roots_test.go",
];
const patchTargets = [
  "cmd/tsconnect/wasm/wasm_js.go",
  "net/tsdial/tsdial.go",
  "ipn/ipnlocal/node_backend.go",
  "derp/derphttp/derphttp_client.go",
];

function requirePaths(files, expected) {
  if (
    files.length !== expected.length ||
    files.some((file, index) => file.path !== expected[index])
  )
    throw new Error("Native node staging paths differ from the fixed scope.");
}

export function stagedNativeNodePath(source, name) {
  if (!nodeNames.includes(name) || !name.endsWith(".go"))
    throw new Error("Native Go staging path is outside the fixed scope.");
  const directory =
    name === "derp-custom-roots_test.go"
      ? "derp/derphttp"
      : name === "native-extra-dns.go" || name === "native-extra-dns_test.go"
        ? "ipn/ipnlocal"
        : "cmd/tsconnect/wasm";
  return join(source, directory, name);
}

async function verifyPatchTargets(source, pins, requireHash, stage) {
  for (const file of pins)
    await requireHash(join(source, file.path), file[stage]);
}

// execute and requireHash are the owning driver's existing bounded child and
// digest checks. The helper owns no shell, compiler, download or arbitrary loader.
export async function stageNativeNode({
  here,
  source,
  pins,
  execute,
  requireHash,
}) {
  if (pins.nativeHttp.packagePath !== "cmd/tsconnect/nativehttp")
    throw new Error("Native package differs from the fixed scope.");
  requirePaths(pins.nativeBridge.files, bridgeNames);
  requirePaths(pins.nativeNode.files, nodeNames);
  requirePaths(pins.nativeNode.patchTargets, patchTargets);
  for (const file of [...pins.nativeBridge.files, ...pins.nativeNode.files])
    await requireHash(join(here, file.path), file.sha256);
  await verifyPatchTargets(
    source,
    pins.nativeNode.patchTargets,
    requireHash,
    "beforeSha256",
  );
  for (const name of ["nativehttp_js.go", "streaming_js.go"])
    await copyFile(
      join(here, name),
      join(source, "cmd/tsconnect/nativehttp", name),
      constants.COPYFILE_EXCL,
    );
  for (const file of pins.nativeNode.files) {
    if (!file.path.endsWith(".go")) continue;
    await copyFile(
      join(here, file.path),
      stagedNativeNodePath(source, file.path),
      constants.COPYFILE_EXCL,
    );
  }
  const verify = async () => {
    for (const file of [...pins.nativeBridge.files, ...pins.nativeNode.files])
      await requireHash(join(here, file.path), file.sha256);
    for (const name of ["nativehttp_js.go", "streaming_js.go"])
      await requireHash(
        join(source, "cmd/tsconnect/nativehttp", name),
        pins.nativeBridge.files.find((file) => file.path === name).sha256,
      );
    for (const file of pins.nativeNode.files) {
      if (!file.path.endsWith(".go")) continue;
      await requireHash(stagedNativeNodePath(source, file.path), file.sha256);
    }
  };
  await execute(
    "patch",
    ["--batch", "--forward", "-p1", "-i", join(here, "native-node.patch")],
    "native-node-patch",
    verify,
  );
  await verify();
  await verifyPatchTargets(
    source,
    pins.nativeNode.patchTargets,
    requireHash,
    "afterSha256",
  );
}
