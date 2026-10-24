/** Disable upstream remote logtail before any owned browser-node logging. */
import { join } from "node:path";

export async function stagePrivateLogging({
  here,
  source,
  pins,
  execute,
  requireHash,
}) {
  const selection = pins.privateLogging;
  const patch = join(here, "disable-logtail.patch");
  const target = join(source, "cmd/tsconnect/wasm/wasm_js.go");
  const verify = () => requireHash(patch, selection.patchSha256);
  await verify();
  await requireHash(target, selection.beforeSha256);
  await execute(
    "patch",
    ["--batch", "--forward", "--fuzz=0", "-p1", "-i", patch],
    "disable-remote-logtail",
    verify,
  );
  await verify();
  await requireHash(target, selection.afterSha256);
}
