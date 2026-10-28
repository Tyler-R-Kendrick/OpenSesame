/** Bind the existing WASM SSH method to the selected peer's host keys. */
import { join } from "node:path";

export async function stageNativeSSH({
  here,
  source,
  pins,
  execute,
  requireHash,
}) {
  const spec = pins.nativeSSH;
  const target = join(source, "cmd/tsconnect/wasm/wasm_js.go");
  const patch = join(here, "native-ssh.patch");
  if (
    spec.patch.path !== "native-ssh.patch" ||
    spec.stagingHelper.path !== "stage-native-ssh.mjs"
  )
    throw new Error("Native SSH fixed staging scope differs.");
  const verify = async () => {
    await requireHash(patch, spec.patch.sha256);
    await requireHash(
      join(here, "stage-native-ssh.mjs"),
      spec.stagingHelper.sha256,
    );
  };
  await verify();
  await requireHash(target, spec.patch.beforeSha256);
  await execute(
    "patch",
    ["--batch", "--forward", "-p1", "-i", patch],
    "native-ssh-patch",
    verify,
  );
  await verify();
  await requireHash(target, spec.patch.afterSha256);
  return verify;
}
