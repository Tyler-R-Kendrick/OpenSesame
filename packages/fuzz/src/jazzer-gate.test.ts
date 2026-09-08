import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([0, 1])(
  "runs only native targets and propagates status %i",
  (status) => {
    const root = mkdtempSync(join(tmpdir(), "opensesame-jazzer-gate-"));
    try {
      const pkg = join(root, "packages/fuzz");
      const bin = join(root, "bin");
      mkdirSync(join(root, "scripts"), { recursive: true });
      mkdirSync(join(pkg, "src"), { recursive: true });
      mkdirSync(join(pkg, "node_modules/.bin"), { recursive: true });
      mkdirSync(bin);
      copyFileSync(
        fileURLToPath(
          new URL("../../../scripts/jazzer-gate.sh", import.meta.url),
        ),
        join(root, "scripts/jazzer-gate.sh"),
      );
      writeFileSync(join(pkg, "package.json"), "{}");
      for (const name of [
        "alpha",
        "beta",
        "alpha.test",
        "oracles",
        "provider",
        "run",
      ]) {
        writeFileSync(join(pkg, `src/${name}.ts`), "");
      }
      writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      writeFileSync(
        join(pkg, "node_modules/.bin/jazzer"),
        '#!/bin/sh\nprintf "%s\\n" "$NODE_OPTIONS" "$@" >> "$GATE_CALLS"\nexit "$GATE_STATUS"\n',
        { mode: 0o700 },
      );
      const calls = join(root, "calls");
      const result = spawnSync("bash", [join(root, "scripts/jazzer-gate.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:/usr/bin:/bin`,
          NODE_OPTIONS: "--no-warnings",
          FUZZ_SECONDS: "3",
          JAZZER_ALLOW_FALLBACK: "0",
          GATE_CALLS: calls,
          GATE_STATUS: String(status),
        },
      });
      expect(result.status, result.stderr).toBe(status);
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(
        ["alpha", "beta"].flatMap((name) => [
          "--no-warnings --import=tsx",
          `src/${name}`,
          "--",
          "-max_total_time=3",
          `-artifact_prefix=${pkg}/artifacts/${name}-`,
        ]),
      );
      expect(result.stdout.includes("jazzer-gate: CLEAN")).toBe(status === 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
