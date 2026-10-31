/** Select exact reviewed compiler/module inputs in owned upstream staging. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function replaceOnce(text, before, after) {
  const parts = text.split(before);
  if (parts.length !== 2)
    throw new Error(
      "Owned module selection input is not the exact pinned occurrence.",
    );
  return parts.join(after);
}

// No upstream assertion is disabled. The patch explicitly selects the reviewed
// compiler's exact embedded revision; the original mismatch assertion stays intact.
export async function selectNativeToolchain({
  here,
  source,
  output,
  pins,
  execute,
  requireHash,
}) {
  const selection = pins.toolchainSelection;
  if (selection.module !== "golang.org/x/crypto/x509roots/fallback")
    throw new Error(
      "Owned module selection differs from the fixed dependency.",
    );
  if (pins.compiler.commit !== selection.selectedCompilerCommit)
    throw new Error("Selected compiler and owned source revision differ.");
  const patch = join(here, "native-toolchain.patch");
  const revision = join(source, "go.toolchain.rev");
  const verify = async () => {
    await requireHash(patch, selection.patchSha256);
    for (const name of ["go.mod", "go.sum", "assert_ts_toolchain_match.go"])
      await requireHash(join(source, name), selection.originalFiles[name]);
  };
  await verify();
  await requireHash(revision, selection.beforeRevisionSha256);
  const originalMod = await readFile(join(source, "go.mod"), "utf8");
  const originalSum = await readFile(join(source, "go.sum"), "utf8");
  const modules = [
    "crypto",
    "mod",
    "net",
    "sync",
    "sys",
    "term",
    "tools",
    "telemetry",
    "text",
  ].map((name) => `golang.org/x/${name}`);
  if (
    selection.dependencies?.length !== modules.length ||
    selection.dependencies.some(
      (entry, index) => entry.module !== modules[index],
    )
  )
    throw new Error(
      "Owned dependency updates differ from the reviewed fixed modules.",
    );
  let mod = originalMod;
  for (const entry of [selection, ...selection.dependencies]) {
    mod = replaceOnce(
      mod,
      `${entry.module} ${entry.beforeVersion}`,
      `${entry.module} ${entry.version}`,
    );
  }
  let sum = originalSum;
  for (const replacement of selection.sumLines) {
    sum = replaceOnce(sum, `${replacement.before}\n`, `${replacement.after}\n`);
  }
  const modfile = join(output, "native.mod");
  await writeFile(modfile, mod, { flag: "wx" });
  await writeFile(join(output, "native.sum"), sum, { flag: "wx" });
  await execute(
    "patch",
    ["--batch", "--forward", "-p1", "-i", patch],
    "select-native-toolchain",
    verify,
  );
  await verify();
  await requireHash(revision, selection.afterRevisionSha256);
  return `-p=2 -buildvcs=false -mod=readonly -modfile=${modfile}`;
}
