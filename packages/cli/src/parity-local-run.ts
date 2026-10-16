/**
 * Direct child execution for values the core already resolved (os://
 * references and mounts): the local half of the `run` inject lane.
 */
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { passwordAgentPolicy } from "@opensesame/app-core/lib/password-agent/policy.js";
import { assertSafeRunName } from "@opensesame/app-core/lib/password-agent/startup-env.js";
import { emitChildStderr, emitChildStdout } from "./output.js";

/** What replaces an injected secret in child output (the redaction marker). */
export const SECRET_MASK = "[REDACTED]";

/** Streaming masker over child output: feed chunks, flush at close. */
export interface SecretMasker {
  push(chunk: string): string;
  flush(): string;
}

/**
 * Streaming replacement of injected values in child output, the local half
 * of what `op run` masking does for op:// values. A tail is held back so a
 * value split across chunks is still caught whole.
 */
export function createSecretMasker(secrets: readonly string[]): SecretMasker {
  const variants = new Set<string>();
  for (const secret of secrets) {
    // A value read from a provider often carries a trailing newline the
    // child may not print; the stripped form is a prefix of the raw one,
    // so masking it covers both without eating the child's line breaks.
    const stripped = secret.replace(/\r?\n$/, "");
    if (stripped) variants.add(stripped);
  }
  const ordered = [...variants].sort((a, b) => b.length - a.length);
  const holdBack = Math.max(0, ...ordered.map((variant) => variant.length - 1));
  let buffered = "";
  const mask = (text: string): string => {
    let masked = text;
    for (const variant of ordered)
      masked = masked.replaceAll(variant, SECRET_MASK);
    return masked;
  };
  return {
    push(chunk: string): string {
      buffered += chunk;
      let cut = buffered.length - holdBack;
      if (cut <= 0) return "";
      // Never split an occurrence across the emit boundary: move the cut
      // left of any occurrence that crosses it, until stable.
      let moved = true;
      while (moved) {
        moved = false;
        for (const variant of ordered) {
          let from = 0;
          for (;;) {
            const index = buffered.indexOf(variant, from);
            if (index < 0 || index >= cut) break;
            if (index + variant.length > cut) {
              cut = index;
              moved = true;
              break;
            }
            from = index + 1;
          }
        }
      }
      const safe = buffered.slice(0, cut);
      buffered = buffered.slice(cut);
      return mask(safe);
    },
    flush(): string {
      const rest = mask(buffered);
      buffered = "";
      return rest;
    },
  };
}

/** Mount files live in one owner-only directory for exactly one child run. */
export async function withMountFiles<T>(
  mounts: readonly { name: string; value: string }[],
  body: (paths: Readonly<Record<string, string>>) => Promise<T>,
): Promise<T> {
  if (!mounts.length) return body({});
  const directory = await mkdtemp(join(tmpdir(), "opensesame-run-mount-"));
  try {
    await chmod(directory, 0o700);
    const paths: Record<string, string> = {};
    for (const mount of mounts) {
      assertSafeRunName(mount.name);
      const file = join(directory, mount.name);
      await writeFile(file, mount.value, { mode: 0o600, flag: "wx" });
      await chmod(file, 0o600);
      paths[mount.name] = file;
    }
    return await body(paths);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Run a child with values the core already resolved (os:// and mounts).
 * Output is piped through the masker instead of inherited, so an injected
 * value the child prints never reaches the terminal or a log in the clear.
 */
export function runChildWithValues(
  command: readonly string[],
  values: Readonly<Record<string, string>>,
  mounts: readonly { name: string; value: string }[] = [],
  secrets: readonly string[] = [],
): Promise<number> {
  if (!command.length) throw new Error("A child command is required after --.");
  for (const name of Object.keys(values)) assertSafeRunName(name);
  return withMountFiles(mounts, async (paths) => {
    for (const name of Object.keys(paths)) assertSafeRunName(name);
    const env: NodeJS.ProcessEnv = { ...process.env, ...values, ...paths };
    const reserved = new Set(passwordAgentPolicy.credentialStartupEnvKeys);
    for (const key of Object.keys(env))
      if (key === "OP_SERVICE_ACCOUNT_TOKEN" || reserved.has(key.toUpperCase()))
        delete env[key];
    // Mount contents are secret by construction; env values mask only
    // when the core lists them (literals from a template never mask).
    const masked = [...secrets, ...mounts.map(({ value }) => value)];
    return new Promise<number>((resolve, reject) => {
      const child = spawn(command[0] ?? "", command.slice(1), {
        cwd: process.cwd(),
        env,
        stdio: ["inherit", "pipe", "pipe"],
        shell: false,
      });
      const stdoutMask = createSecretMasker(masked);
      const stderrMask = createSecretMasker(masked);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) =>
        emitChildStdout(stdoutMask.push(chunk)),
      );
      child.stderr.on("data", (chunk: string) =>
        emitChildStderr(stderrMask.push(chunk)),
      );
      child.on("error", () =>
        reject(new Error("Could not start the child command.")),
      );
      child.on("close", (code) => {
        emitChildStdout(stdoutMask.flush());
        emitChildStderr(stderrMask.flush());
        resolve(code ?? 1);
      });
    });
  });
}
