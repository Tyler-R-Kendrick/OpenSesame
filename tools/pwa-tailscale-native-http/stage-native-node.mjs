/** Stage only the reviewed bridge and original-node hook into owned source. */
import { constants, copyFile } from "node:fs/promises";
import { join } from "node:path";

const bridgeNames = [
  "nativehttp_js.go",
  "native-http.mjs",
  "native-http.test.mjs",
];
const nodeNames = ["nodehttp_js.go", "native-node.patch"];
const patchTargets = ["cmd/tsconnect/wasm/wasm_js.go", "net/tsdial/tsdial.go"];

function requirePaths(files, expected) {
  if (
    files.length !== expected.length ||
    files.some((file, index) => file.path !== expected[index])
  )
    throw new Error("Native node staging paths differ from the fixed scope.");
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
  await copyFile(
    join(here, "nativehttp_js.go"),
    join(source, "cmd/tsconnect/nativehttp/nativehttp_js.go"),
    constants.COPYFILE_EXCL,
  );
  await copyFile(
    join(here, "nodehttp_js.go"),
    join(source, "cmd/tsconnect/wasm/nodehttp_js.go"),
    constants.COPYFILE_EXCL,
  );
  const verify = async () => {
    for (const file of [...pins.nativeBridge.files, ...pins.nativeNode.files])
      await requireHash(join(here, file.path), file.sha256);
    await requireHash(
      join(source, "cmd/tsconnect/nativehttp/nativehttp_js.go"),
      pins.nativeBridge.files[0].sha256,
    );
    await requireHash(
      join(source, "cmd/tsconnect/wasm/nodehttp_js.go"),
      pins.nativeNode.files[0].sha256,
    );
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
