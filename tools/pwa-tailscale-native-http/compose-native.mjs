/** Fixed original-node composition; input downloads belong to the owning driver. */
import { constants, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { selectNativeToolchain } from "./select-toolchain.mjs";
import { stageNativeNode, stagedNativeNodePath } from "./stage-native-node.mjs";
import { stagePeerGET } from "./stage-peer-get.mjs";
import { stagePrivateLogging } from "./stage-private-logging.mjs";
import { stageNativeSSH } from "./stage-native-ssh.mjs";

const rootNames = ["public-roots.go", "public-roots_test.go"];

async function stagePublicRoots({ here, source, pins, requireHash }) {
  const files = pins.publicTrust.files;
  if (
    files.length !== 2 ||
    files.some((file, index) => file.path !== rootNames[index])
  )
    throw new Error("Public roots differ from the two fixed native overlays.");
  for (const file of files) {
    await requireHash(join(here, file.path), file.sha256);
    await copyFile(
      join(here, file.path),
      join(source, "cmd/tsconnect/nativehttp", file.path),
      constants.COPYFILE_EXCL,
    );
    await requireHash(
      join(source, "cmd/tsconnect/nativehttp", file.path),
      file.sha256,
    );
  }
}

async function verifyComposition({ here, source, output, pins, requireHash }) {
  const expected = [
    ...pins.nativeBridge.files,
    ...pins.nativeNode.files,
    pins.nativeNode.stagingHelper,
    ...pins.composition.files,
    ...pins.toolchainSelection.files,
    ...pins.privateLogging.files,
    ...pins.publicTrust.files,
    pins.nativeSSH.patch,
    pins.nativeSSH.stagingHelper,
  ];
  for (const file of expected)
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
  for (const file of pins.publicTrust.files)
    await requireHash(
      join(source, "cmd/tsconnect/nativehttp", file.path),
      file.sha256,
    );
  await requireHash(
    join(source, "cmd/tsconnect/wasm/wasm_js.go"),
    pins.nativeSSH.patch.afterSha256,
  );
  for (const file of pins.nativeNode.patchTargets.slice(1))
    await requireHash(join(source, file.path), file.afterSha256);
  await requireHash(
    join(source, "go.toolchain.rev"),
    pins.toolchainSelection.afterRevisionSha256,
  );
  for (const name of ["go.mod", "go.sum", "assert_ts_toolchain_match.go"])
    await requireHash(
      join(source, name),
      pins.toolchainSelection.originalFiles[name],
    );
  // The selector derives both files; later compiler invocations use these exact
  // owned files with -mod=readonly, never an ambient workspace/module rewrite.
  await requireHash(join(output, "native.mod"), pins.composition.modSha256);
  await requireHash(join(output, "native.sum"), pins.composition.sumSha256);
}

export async function composeNative(options) {
  const flags = await selectNativeToolchain(options);
  await stagePublicRoots(options);
  await stageNativeNode(options);
  await stagePrivateLogging(options);
  const verifyPeerGET = await stagePeerGET(options);
  const verifySSH = await stageNativeSSH(options);
  const verify = async () => {
    await verifyPeerGET();
    await verifySSH();
    await verifyComposition(options);
  };
  await verify();
  return { flags, verify };
}

const inheritedNames = new Set([
  "PATH",
  "LANG",
  "TZ",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_MONETARY",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);
export function nativeBuildEnvironment(
  output,
  moduleFlags,
  parent = process.env,
) {
  const env = {};
  for (const key of inheritedNames)
    if (parent[key] !== undefined) env[key] = parent[key];
  return Object.assign(env, {
    GOMAXPROCS: "2",
    GOMEMLIMIT: "2GiB",
    GOFLAGS: moduleFlags,
    GOTOOLCHAIN: "local",
    GOENV: "off",
    GOWORK: "off",
    GOTELEMETRY: "off",
    GOCACHE: join(output, "cache", "build"),
    GOMODCACHE: join(output, "cache", "mod"),
    GOPATH: join(output, "cache", "gopath"),
    TMPDIR: join(output, "tmp"),
    GOPROXY: "https://proxy.golang.org",
    GOSUMDB: "sum.golang.org",
    GOPRIVATE: "",
    GONOPROXY: "",
    GONOSUMDB: "",
    VERSION_LONG: "",
    VERSION_SHORT: "",
  });
}
