import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type BoundaryValue, isFunction } from "@opensesame/os-domain";

const SKIP = new Set([
  "oracles.ts",
  "oracles.test.ts",
  "provider.ts",
  "run.ts",
]);

type FuzzTarget = (input: Buffer) => void;

interface FuzzModule {
  fuzz?: BoundaryValue;
}

function isFuzzTarget(value: BoundaryValue): value is FuzzTarget {
  return isFunction(value);
}

export async function runTarget(
  fileUrl: string,
  seconds: number,
): Promise<void> {
  const mod: FuzzModule = await import(fileUrl);
  if (!isFuzzTarget(mod.fuzz)) {
    return;
  }
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    mod.fuzz(randomBytes(64));
  }
}

export async function main(): Promise<void> {
  const seconds = Number(process.env.FUZZ_SECONDS ?? 5);
  const only = process.argv[2];
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = (await readdir(dir))
    .filter(
      (name) =>
        name.endsWith(".ts") && !name.endsWith(".test.ts") && !SKIP.has(name),
    )
    .filter((name) => (only ? name.startsWith(only) : true));
  process.stdout.write(
    "==> local fuzz runner: DEGRADED (uncoverage-guided fallback; random bytes only)\n",
  );
  for (const name of files) {
    const fileUrl = pathToFileURL(path.join(dir, name)).href;
    process.stdout.write(`--> ${name} (${seconds}s)\n`);
    await runTarget(fileUrl, seconds);
  }
  process.stdout.write(
    "local fuzz runner: DEGRADED (uncoverage-guided fallback) — no coverage feedback; not equivalent to Jazzer.js\n",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
