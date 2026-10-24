/** Fixed additive peer-GET source, after original node+private logging. */
import { constants, copyFile } from "node:fs/promises";
import { join } from "node:path";
const paths = [
  ["peer-get.go", "cmd/tsconnect/nativehttp"],
  ["peer-get_test.go", "cmd/tsconnect/nativehttp"],
  ["peer-get-tls_test.go", "cmd/tsconnect/nativehttp"],
  ["peer-get-tls_js_test.go", "cmd/tsconnect/nativehttp"],
  ["peer-get-capacity_test.go", "cmd/tsconnect/nativehttp"],
  ["peer-get_js.go", "cmd/tsconnect/nativehttp"],
  ["peer-get_js_test.go", "cmd/tsconnect/nativehttp"],
  ["nodepeerget_js.go", "cmd/tsconnect/wasm"],
  ["nodepeerget-tls_js_test.go", "cmd/tsconnect/wasm"],
];
export async function stagePeerGET({
  here,
  source,
  pins,
  execute,
  requireHash,
}) {
  const spec = pins.peerGET;
  if (
    !spec ||
    spec.files.length !== paths.length ||
    spec.files.some((file, index) => file.path !== paths[index][0])
  )
    throw new Error("Peer GET fixed scope differs");
  const target = join(source, "cmd/tsconnect/wasm/wasm_js.go");
  await requireHash(target, spec.patch.beforeSha256);
  for (const file of spec.files)
    await requireHash(join(here, file.path), file.sha256);
  await requireHash(join(here, "native-peer-get.patch"), spec.patch.sha256);
  await requireHash(
    join(here, "stage-peer-get.mjs"),
    spec.stagingHelper.sha256,
  );
  for (const [name, folder] of paths)
    await copyFile(
      join(here, name),
      join(source, folder, name),
      constants.COPYFILE_EXCL,
    );
  const verify = async () => {
    for (const [name, folder] of paths) {
      const expected = spec.files.find((file) => file.path === name).sha256;
      await requireHash(join(here, name), expected);
      await requireHash(join(source, folder, name), expected);
    }
    await requireHash(join(here, "native-peer-get.patch"), spec.patch.sha256);
    await requireHash(
      join(here, "stage-peer-get.mjs"),
      spec.stagingHelper.sha256,
    );
  };
  await execute(
    "patch",
    ["--batch", "--forward", "-p1", "-i", join(here, "native-peer-get.patch")],
    "native-peer-get-patch",
    verify,
  );
  await verify();
  await requireHash(target, spec.patch.afterSha256);
  // The complete final node hash belongs to composition.nativeNodeSHA256;
  // later reviewed FOKS/identity patches may follow this exact intermediate.
  return verify;
}
