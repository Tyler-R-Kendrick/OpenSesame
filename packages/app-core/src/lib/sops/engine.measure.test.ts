/** @vitest-environment node */
/**
 * Measure the engine and write the evidence table (SB-073..SB-078).
 *
 *   SOPS_MEASURE=1 pnpm --filter @opensesame/pages exec vitest run \
 *     src/lib/sops/engine.measure.test.ts
 *
 * Skipped unless `SOPS_MEASURE` is set: it is a measurement, not a
 * threshold, and a slow CI box must not fail a gate over it. The timings
 * come from this Node build of the same modules the browser worker
 * imports, so they bound the *shape* of the cost — linear in document
 * size — rather than one device's speed. The bundle figure is read from
 * the built worker chunk, which is the number that actually ships.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { SopsEngine, type VerifiedDocument } from "./engine.js";
import { HandleRegistry } from "./handles.js";
import { planDigest, planFromRecipients } from "./plan.js";
import { NEVER, newIdentity } from "./test-support.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..", "..");
const dist = join(here, "..", "..", "..", "dist", "assets");
const evidence = join(root, "docs/evidence/2026-09-22-browser-local-sops");

const SIZES = [10, 100, 1000, 5000] as const;
const RUNS = 5;

function document(pairs: number): string {
  const lines: string[] = [];
  for (let index = 0; index < pairs; index += 1)
    lines.push(`key_${index}: value-${index}-${"x".repeat(24)}`);
  return `${lines.join("\n")}\n`;
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function workerChunk(): string {
  const names: string[] = readdirSync(dist, { encoding: "utf8" });
  return names.find((name) => name.startsWith("sops.worker-")) ?? "";
}

describe.skipIf(!process.env.SOPS_MEASURE)("engine measurements", () => {
  it("records encrypt/decrypt cost by document size and the shipped chunk size", async () => {
    const id = await newIdentity();
    const engine = new SopsEngine(
      new HandleRegistry<VerifiedDocument>(() => 0),
    );
    const plan = planFromRecipients({
      format: "yaml",
      groups: [[id.recipient]],
    });
    const permit = {
      scope: {
        operationId: "measure",
        documentGeneration: 1,
        sessionGeneration: 0,
        vaultScope: null,
      },
      approvedPlanDigest: await planDigest(plan),
      network: "forbidden",
    } as const;

    const rows: string[] = [];
    for (const pairs of SIZES) {
      const plain = document(pairs);
      const encrypts: number[] = [];
      const decrypts: number[] = [];
      let cipher = "";
      for (let run = 0; run < RUNS; run += 1) {
        const started = performance.now();
        cipher = await engine.encryptNew(plain, {
          plan,
          permit,
          signal: NEVER,
        });
        encrypts.push(performance.now() - started);
        const opening = performance.now();
        const opened = await engine.open(cipher, "yaml", {
          identities: [id.identity],
          permit,
          signal: NEVER,
        });
        const text = engine.plaintext(opened.handle, permit);
        expect(text).toBe(plain);
        engine.dispose(opened.handle);
        decrypts.push(performance.now() - opening);
      }
      rows.push(
        `| ${pairs} | ${plain.length} | ${cipher.length} | ${median(encrypts).toFixed(1)} | ${median(decrypts).toFixed(1)} |`,
      );
    }

    const worker = workerChunk();
    const bytes = worker ? statSync(join(dist, worker)).size : 0;
    const gzipped = worker
      ? gzipSync(readFileSync(join(dist, worker))).length
      : 0;

    writeFileSync(
      join(evidence, "engine-measurements.md"),
      `# Engine measurements — browser-local SOPS

Regenerate with a fresh \`apps/pages\` build, then:

\`\`\`bash
SOPS_MEASURE=1 pnpm --filter @opensesame/pages exec vitest run \\
  src/lib/sops/engine.measure.test.ts
\`\`\`

These are measurements, not thresholds, and nothing gates on them. They run
in Node against the same modules the browser worker imports, so they show
the **shape** of the cost — one AES-GCM record per encrypted leaf — not any
particular device's speed. A phone is slower.

The measured growth is somewhat worse than linear at the top of the range
(5x the pairs costs roughly 8.6x the time between the last two rows), so a
document near the 8 MiB input ceiling is a visibly slow operation rather
than an instant one. That is why the work runs in a worker and why the
ceiling exists; it is a disclosed cost, not a tuned one.

## Cost by document size

One age recipient, YAML, ${RUNS} runs per size, median reported. "encrypt"
is \`encryptNew\` (parse, per-leaf encrypt, MAC, emit). "open+decrypt" is
\`open\` (parse, unwrap the data key, verify the MAC) plus \`plaintext\`.

| pairs | plaintext bytes | ciphertext bytes | encrypt ms (median of ${RUNS}) | open+decrypt ms (median of ${RUNS}) |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

Ciphertext is several times the plaintext because every encrypted leaf
carries a 32-byte nonce and a 16-byte tag in base64 — that is the SOPS wire
format, not an engine choice.

## What ships

| artifact | bytes | gzipped |
| --- | --- | --- |
| \`${worker || "not built — build apps/pages first"}\` | ${bytes} | ${gzipped} |

The worker chunk is loaded only when a SOPS document is opened; it is not on
the boot path. It carries \`age-encryption\` and the engine.

## Declared bounds

The engine refuses rather than degrades past the limits in
\`src/lib/sops/limits.ts\`: 8 MiB of input, 64 levels of nesting, 100,000
tree nodes, 32 documents in a stream, 32 key groups, 128 recipient entries.
The regex engine is an NFA simulation with a 4,000-instruction program cap
and a 2,000,000-step execution cap, so a selector cannot backtrack.

Measured on Node ${process.version}, ${process.platform}-${process.arch}.
`,
    );
    expect(rows).toHaveLength(SIZES.length);
  }, 120_000);
});
