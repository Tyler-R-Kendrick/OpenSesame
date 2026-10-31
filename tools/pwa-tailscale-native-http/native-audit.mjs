/** Audit exactly the prepared production JS/WASM import graph, including unused affected functions. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativeBuildEnvironment } from "./compose-native.mjs";

export const upstreamCompileHelper = String.raw`package main
import ("encoding/json";"os";"tailscale.com/cmd/tsconnect/wasmbuild")
func main(){
 if len(os.Args)==3 && os.Args[1]=="tags" {b,e:=json.Marshal(wasmbuild.Tags());if e!=nil{panic(e)};if e=os.WriteFile(os.Args[2],b,0600);e!=nil{panic(e)};return}
 if len(os.Args)!=5 { panic("go phase output receipt required") }
 c:=wasmbuild.ProdCommand(os.Args[1],os.Args[3]);c.Stdout=os.Stdout;c.Stderr=os.Stderr
 r:=map[string]any{"phase":os.Args[2],"command":c.Args,"keep":wasmbuild.Keep,"tags":wasmbuild.Tags(),"ldflags":wasmbuild.ProdLDFlags()}
 e:=c.Run();r["pass"]=e==nil;if e!=nil {r["error"]=e.Error()}
 b,j:=json.MarshalIndent(r,"","  ");if j!=nil {panic(j)}
 if j=os.WriteFile(os.Args[4],append(b,'\n'),0600);j!=nil {panic(j)}
 if e!=nil {os.Exit(1)}
}`;

export async function compileNativePhase(
  phase,
  { compiler, artifacts, output, execute, digest },
) {
  const go = join(compiler, "bin", "go");
  const artifact = join(artifacts, `${phase}.raw.wasm`);
  await execute(
    go,
    [
      "run",
      join(output, "upstream-command.go"),
      go,
      phase,
      artifact,
      join(output, `${phase}.json`),
    ],
    phase,
  );
  return { phase, sha256: await digest(artifact) };
}
function nextStringState(char, escaped) {
  if (escaped) return { quoted: true, escaped: false };
  if (char === "\\") return { quoted: true, escaped: true };
  return { quoted: char !== '"', escaped: false };
}

/** Go's tools emit a stream of JSON objects, not one JSON document. Reject truncation and noise. */
export function jsonObjects(text) {
  const values = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start === -1) {
      if (/\s/.test(char)) continue;
      if (char !== "{")
        throw new Error("Native audit output is not a JSON object stream.");
      start = index;
    }
    if (quoted) {
      ({ quoted, escaped } = nextStringState(char, escaped));
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      if (--depth === 0) {
        values.push(JSON.parse(text.slice(start, index + 1)));
        start = -1;
      }
    }
  }
  if (start !== -1 || !values.length)
    throw new Error("Native audit JSON is missing or truncated.");
  return values;
}

function assertScannerConfig(messages, version, target) {
  const configs = messages
    .filter((entry) => entry.config)
    .map((entry) => entry.config);
  const sboms = messages
    .filter((entry) => entry.SBOM)
    .map((entry) => entry.SBOM);
  if (
    configs.length !== 1 ||
    sboms.length !== 1 ||
    configs[0].scanner_name !== "govulncheck" ||
    configs[0].scanner_version !== "v1.9.0" ||
    configs[0].scan_level !== "package" ||
    configs[0].scan_mode !== "source" ||
    configs[0].go_version !== version ||
    sboms[0].go_version !== version ||
    sboms[0].roots?.length !== 1 ||
    sboms[0].roots[0] !== target
  )
    throw new Error(
      "Native audit scanner, compiler or production target differs.",
    );
  return sboms[0];
}

function assertScannerModules(packages, sbom, version) {
  const modules = new Map([["stdlib", `v${version.slice(2)}`]]);
  for (const entry of packages) {
    const module = entry.Module?.Replace ?? entry.Module;
    if (module) modules.set(module.Path, module.Version ?? "");
  }
  const reported = sbom.modules;
  if (
    !Array.isArray(reported) ||
    reported.length !== modules.size ||
    new Set(reported.map((entry) => entry.path)).size !== reported.length ||
    reported.some(
      (entry) =>
        !modules.has(entry.path) ||
        modules.get(entry.path) !== (entry.version ?? ""),
    )
  )
    throw new Error(
      "Native scanner inventory differs from the actual package graph.",
    );
  return modules;
}

export function assertNativePackageAudit(packages, messages, version) {
  const target = "tailscale.com/cmd/tsconnect/wasm";
  if (
    !packages.some((entry) => entry.ImportPath === target) ||
    packages.some(
      (entry) => entry.Error || entry.DepsErrors?.length || !entry.ImportPath,
    )
  )
    throw new Error("Native audit package graph is incomplete.");
  const sbom = assertScannerConfig(messages, version, target);
  const modules = assertScannerModules(packages, sbom, version);
  const findings = messages
    .filter((entry) => entry.finding)
    .map((entry) => entry.finding);
  if (
    findings.some(
      (entry) =>
        !entry.osv || !Array.isArray(entry.trace) || !entry.trace.length,
    )
  )
    throw new Error("Native scanner returned a malformed finding.");
  const affected = findings.filter((entry) =>
    entry.trace.some((frame) => frame.package),
  );
  if (affected.length)
    throw new Error(
      `Native imported packages have advisories: ${JSON.stringify(affected)}`,
    );
  return {
    packages: packages.length,
    modules: modules.size,
    affectedImportedPackages: 0,
    moduleOnlyAdvisories: [...new Set(findings.map((entry) => entry.osv))],
    compilerVersion: version,
  };
}

/** Decode the Go helper's external JSON value before selecting production tags. */
export async function decodeNativeProductionTags(value) {
  // Audit-only loading keeps ordinary compiler/diagnostic fixture imports independent.
  const z = await import("zod/v4/mini");
  const tags = z
    .string()
    .check(
      z.maxLength(16384),
      z.regex(/^[a-z][a-z0-9_]*(?:,[a-z][a-z0-9_]*)*$/),
    )
    .parse(value);
  const tokens = tags.split(",");
  const selected = new Set(tokens);
  if (
    selected.size !== tokens.length ||
    !selected.has("tailscale_go") ||
    selected.has("ts_omit_useexitnode")
  )
    throw new Error(
      "Native audit must use the final production feature selection.",
    );
  return tags;
}

export async function auditNativePackages({ output, compiler, pins, execute }) {
  const go = join(compiler, "bin/go");
  const flags = `-p=2 -buildvcs=false -mod=readonly -modfile=${join(output, "native.mod")}`;
  const env = nativeBuildEnvironment(output, flags);
  const tagsPath = join(output, "audit-tags.json");
  await execute(
    go,
    ["run", join(output, "upstream-command.go"), "tags", tagsPath],
    "native-audit-tags",
  );
  const tags = await decodeNativeProductionTags(
    JSON.parse(await readFile(tagsPath, "utf8")),
  );
  const bin = join(output, "audit-tools");
  await mkdir(bin);
  await execute(
    go,
    ["install", "golang.org/x/vuln/cmd/govulncheck@v1.9.0"],
    "native-audit-tool",
    undefined,
    {
      env: {
        ...nativeBuildEnvironment(output, "-p=2 -buildvcs=false"),
        GOBIN: bin,
      },
    },
  );
  const packageEnv = {
    ...env,
    GOOS: "js",
    GOARCH: "wasm",
    PATH: `${join(compiler, "bin")}:${env.PATH ?? ""}`,
  };
  const graphPath = join(output, "native-package-graph.json");
  const scanPath = join(output, "native-vulnerability-scan.json");
  const target = "tailscale.com/cmd/tsconnect/wasm";
  await execute(
    go,
    ["list", "-deps", "-json", "-tags", tags, target],
    "native-audit-graph",
    undefined,
    { env: packageEnv, stdoutPath: graphPath },
  );
  await execute(
    join(bin, "govulncheck"),
    ["-scan=package", "-json", "-tags", tags, target],
    "native-audit-packages",
    undefined,
    { env: packageEnv, stdoutPath: scanPath },
  );
  const result = assertNativePackageAudit(
    jsonObjects(await readFile(graphPath, "utf8")),
    jsonObjects(await readFile(scanPath, "utf8")),
    pins.compiler.version,
  );
  await writeFile(
    join(output, "native-audit.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { flag: "wx" },
  );
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  const metadata = JSON.parse(
    await readFile(
      join(
        repository,
        "apps/pages/src/lib/capabilities/tailscale-artifacts.json",
      ),
      "utf8",
    ),
  );
  const { prepareNativeAudit } = await import("./prepare-distribution.mjs");
  const result = await prepareNativeAudit(
    repository,
    metadata.native.sourceMetadataSha256,
    process.env.OPENSESAME_AUDIT_DIR,
  );
  console.log(
    `Native JS/WASM package audit: ${result.packages} packages, ${result.modules} modules, zero affected imported packages; module-only advisories retained: ${result.moduleOnlyAdvisories.join(", ") || "none"}.`,
  );
}
