import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import ts from "typescript";
import { searchForWorkspaceRoot, transformWithEsbuild } from "vite";
import { bitwardenWorkerAssets } from "./bitwarden-worker-assets.mjs";
import { workerRealmSource } from "./lib/capability-graph.mjs";
import { defaultWorkers, workerPlanOwners } from "./shared-worker-plans.mjs";

const PREFIX = "\0opensesame-worker:";
const purePackages =
  /\/node_modules\/(?:zod|@noble\/(?:ciphers|hashes)|hash-wasm|@levischuck\/tiny-cbor)\//;
const closedLeaves = [
  "packages/vault-core/src/bytes.ts",
  "packages/app-core/src/lib/zod-jitless.ts",
  ...[
    "wasm-gzip-asset",
    "bitwarden-worker-protocol",
    "bitwarden-native-worker-protocol",
    "bitwarden-native-contract",
    "bitwarden-native-network-protocol",
  ].map((name) => `packages/app-core/src/lib/secret-backends/${name}.ts`),
];
function pureSources(root) {
  const workspace = searchForWorkspaceRoot(root);
  const closed = new Set(closedLeaves.map((file) => resolve(workspace, file)));
  return { closed, test: (id) => purePackages.test(id) || closed.has(id) };
}
const virtual = (realm, file) =>
  `${PREFIX}${realm}:${Buffer.from(file).toString("base64url")}${extname(file)}`;
function original(id) {
  const file = id && workerRealmSource(id);
  if (!file) return undefined;
  return { realm: id.slice(PREFIX.length).split(":", 1)[0], file };
}
function privateSource(file, realm, sdk) {
  if (sdk?.owns(file, realm)) return true;
  const path = file.replaceAll("\\", "/");
  if (/\/packages\/os-domain\/src\//.test(path)) return true;
  if (
    /\/packages\/(?:os-domain\/src\/json|vault-core\/src\/bytes|app-core\/src\/lib\/zod-jitless)\.ts$/.test(
      path,
    )
  )
    return true;
  return realm === "tailscale-node"
    ? /\/(?:src\/modules\/networking\.tailnet\/browser\/(?:worker|worker-csp|worker-native-http|worker-peer-get|protocol|sdk|sdk-peer-get|worker-egress)|packages\/app-core\/src\/lib\/tailscale\/(?:browser-node-peer-http|browser-node-port))\.ts$/.test(
        path,
      )
    : /\/packages\/app-core\/src\/lib\/secret-backends\/[^/]+\.(?:ts|json)$/.test(
        path,
      );
}

function mintModule(minted, realm, file, sdk) {
  if (file !== resolve(file) || !privateSource(file, realm, sdk))
    throw new Error("Worker module needs a canonical private source.");
  const id = virtual(realm, file);
  minted.add(id);
  return id;
}
function ownedRealm(id, minted) {
  if (id?.startsWith("\0opensesame-worker") && !minted.has(id))
    throw new Error("Unowned worker realm module ID.");
  return original(id);
}
async function resolvedImport(ctx, source, importer, parent, sdk) {
  const found = await ctx.resolve(source, parent?.file ?? importer, {
    skipSelf: true,
  });
  if (!found || found.external)
    throw new Error(`Unresolved private worker import: ${source}`);
  return parent
    ? { ...found, id: sdk?.resolve(found.id, parent.realm) ?? found.id }
    : found;
}
async function resolvePrivate(ctx, source, importer, state) {
  const { minted, pureRoots, sdk, pure } = state;
  const parent = ownedRealm(importer, minted);
  if (source.startsWith("\0opensesame-worker")) {
    const target = ownedRealm(source, minted);
    if (parent && parent.realm !== target.realm)
      throw new Error("Private worker realms cannot import each other.");
    return source;
  }
  const shared = pure.closed.has(importer);
  if (!parent && !shared) return;
  const found = await resolvedImport(ctx, source, importer, parent, sdk);
  if (
    parent &&
    pure.closed.has(found.id) &&
    !privateSource(found.id, parent.realm, sdk)
  )
    throw new Error(
      "Closed Worker codec is outside its original realm authority.",
    );
  if (pure.test(found.id.replaceAll("\\", "/"))) {
    pureRoots.add(found.id);
    return found;
  }
  if (shared)
    throw new Error(
      `Closed Worker codec imports unreviewed source: ${found.id}`,
    );
  if (!privateSource(found.id, parent.realm, sdk))
    throw new Error(
      `Worker import crosses its private runtime boundary: ${found.id}`,
    );
  if (found.id.startsWith("\0") || /[?#]/.test(found.id))
    throw new Error("Unsupported private worker module transformation.");
  return { ...found, id: mintModule(minted, parent.realm, found.id, sdk) };
}
async function loadPrivate(ctx, id, minted, sdk) {
  const source = ownedRealm(id, minted);
  if (source) {
    if (
      (await realpath(source.file)) !== source.file ||
      source.file !== resolve(source.file) ||
      !privateSource(source.file, source.realm, sdk)
    )
      throw new Error(
        "Worker module source is not its canonical private file.",
      );
    ctx.addWatchFile(source.file);
    const code =
      sdk?.load(ctx, source.file) ?? (await readFile(source.file, "utf8"));
    return /\.tsx?$/.test(source.file)
      ? transformWithEsbuild(code, source.file, { target: "es2022" })
      : code;
  }
}

function transformWorkerURLs(ctx, code, id, workers, refs, owners, minted) {
  const plans = workers.filter((entry) =>
    workerPlanOwners(entry).includes(id.split("?", 1)[0]),
  );
  if (!plans.length) return;
  const ast = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
  const edits = [];
  const visit = (node) => {
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(ast) === "URL" &&
      node.arguments?.length === 2 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[1].getText(ast) === "import.meta.url"
    ) {
      const plan = plans.find(
        (entry) => entry.specifier === node.arguments[0].text,
      );
      if (plan) {
        let ref = refs.get(plan.name);
        if (!ref) {
          ref = ctx.emitFile({
            type: "chunk",
            id: mintModule(
              minted,
              plan.name,
              resolve(dirname(id), plan.specifier),
            ),
            name: plan.name,
            preserveSignature: "strict",
          });
          refs.set(plan.name, ref);
        }
        owners.set(id, new Set([...(owners.get(id) ?? []), ref]));
        edits.push([
          node.getStart(ast),
          node.end,
          `import.meta.ROLLUP_FILE_URL_${ref}`,
        ]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (edits.length !== plans.length)
    throw new Error("Module worker needs exactly one original URL reference.");
  let transformed = code;
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0]))
    transformed =
      transformed.slice(0, start) + replacement + transformed.slice(end);
  return edits.length ? { code: transformed, map: null } : undefined;
}

function hostModules(chunk, minted, pure) {
  return Object.keys(chunk.modules).filter(
    (id) => !minted.has(id) && !pure.test(id.replaceAll("\\", "/")),
  );
}
function hostModuleError(chunk, minted, label, pure) {
  const modules = hostModules(chunk, minted, pure);
  return new Error(
    `${label}: ${chunk.fileName}; host modules (${modules.length}): ${modules
      .slice(0, 8)
      .map((id) => JSON.stringify(id))
      .join(", ")}`,
  );
}
function purePartitions(ctx, roots, previous, pure) {
  if (previous && !(previous instanceof Function))
    throw new Error(
      "Worker dependency partitions need the existing manual-chunk function.",
    );
  const isolated = new Map();
  const pending = [...roots];
  while (pending.length) {
    const id = pending.pop();
    if (isolated.has(id) || !pure.test(id.replaceAll("\\", "/"))) continue;
    const normalized = id.replaceAll("\\", "/");
    const match = normalized.match(
      /\/node_modules\/(zod|@noble\/(?:ciphers|hashes)|hash-wasm|@levischuck\/tiny-cbor)\//,
    );
    const packageRoot = match
      ? normalized.slice(0, match.index + match[0].length)
      : normalized;
    const identity = createHash("sha256")
      .update(packageRoot)
      .digest("hex")
      .slice(0, 8);
    isolated.set(
      id,
      `native-worker-${(match?.[1] ?? basename(normalized, ".ts")).replaceAll("/", "-").replace("@", "")}-${identity}`,
    );
    const info = ctx.getModuleInfo(id);
    if (info) pending.push(...info.importedIds, ...info.dynamicallyImportedIds);
  }
  return (id, api) => isolated.get(id) ?? previous?.(id, api);
}
function workerClosure(bundle, file, minted, pure, seen = new Set()) {
  if (seen.has(file)) return seen;
  const output = bundle[file];
  if (!output || output.type !== "chunk")
    throw new Error("Worker closure needs an emitted chunk.");
  if (
    Object.keys(output.modules).some(
      (id) => !minted.has(id) && !pure.test(id.replaceAll("\\", "/")),
    )
  )
    throw hostModuleError(
      output,
      minted,
      "Worker closure unexpectedly includes host modules",
      pure,
    );
  seen.add(file);
  for (const next of [...output.imports, ...output.dynamicImports])
    workerClosure(bundle, next, minted, pure, seen);
  for (const next of [
    ...(output.viteMetadata?.importedCss ?? []),
    ...(output.viteMetadata?.importedAssets ?? []),
    ...(output.referencedFiles ?? []),
  ]) {
    if (!bundle[next]) throw new Error("Worker closure asset is absent.");
    seen.add(next);
  }
  return seen;
}

function attachWorkerClosures(ctx, bundle, owners, minted, pure) {
  const privateChunks = Object.values(bundle).filter(
    (out) =>
      out.type === "chunk" &&
      Object.keys(out.modules).some((id) => id.startsWith(PREFIX)),
  );
  for (const chunk of privateChunks) {
    if (
      Object.keys(chunk.modules).some(
        (id) => !minted.has(id) && !pure.test(id.replaceAll("\\", "/")),
      )
    )
      throw hostModuleError(
        chunk,
        minted,
        "Worker-private chunk unexpectedly contains host/shared modules",
        pure,
      );
  }
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== "chunk") continue;
    for (const id of Object.keys(chunk.modules)) {
      for (const ref of owners.get(id) ?? []) {
        chunk.viteMetadata ??= {};
        chunk.viteMetadata.importedAssets ??= new Set();
        for (const file of workerClosure(
          bundle,
          ctx.getFileName(ref),
          minted,
          pure,
        ))
          chunk.viteMetadata.importedAssets.add(file);
      }
    }
  }
  for (const chunk of privateChunks)
    bundle[chunk.fileName] = {
      type: "asset",
      fileName: chunk.fileName,
      names: [],
      originalFileNames: [],
      needsCodeReference: false,
      source: chunk.code,
      opensesameWorkerChunk: chunk,
    };
}

/** Share audited library/codec bytes, not realm instances. @returns {import("vite").Plugin} */
export function sharedWorkerGraph({ workers } = {}) {
  const refs = new Map();
  const owners = new Map();
  const minted = new Set();
  const pureRoots = new Set();
  let plans = workers;
  let sdk;
  let pure;
  return {
    name: "opensesame-shared-worker-graph",
    apply: "build",
    enforce: "pre",
    buildStart() {
      sdk = bitwardenWorkerAssets(plans);
      pureRoots.clear();
      minted.clear();
      refs.clear();
      owners.clear();
    },
    configResolved(config) {
      pure = pureSources(config.root);
      plans ??= defaultWorkers(config.root);
      const originalOwners = plans.flatMap(workerPlanOwners);
      if (
        new Set(plans.map((plan) => plan.name)).size !== plans.length ||
        new Set(originalOwners).size !== originalOwners.length
      )
        throw new Error(
          "Module workers need unique names and original owners.",
        );
    },
    resolveId(source, importer) {
      return resolvePrivate(this, source, importer, {
        minted,
        pureRoots,
        sdk,
        pure,
      });
    },
    load(id) {
      return loadPrivate(this, id, minted, sdk);
    },
    transform(code, id) {
      return transformWorkerURLs(this, code, id, plans, refs, owners, minted);
    },
    outputOptions(options) {
      return {
        ...options,
        manualChunks: purePartitions(
          this,
          pureRoots,
          options.manualChunks,
          pure,
        ),
      };
    },
    generateBundle: {
      order: "pre",
      handler(_options, bundle) {
        attachWorkerClosures(this, bundle, owners, minted, pure);
      },
    },
  };
}
