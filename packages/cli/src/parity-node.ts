/** Native effects for the shared 1Password workflow core. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  constants,
  accessSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  parse,
  sep,
} from "node:path";
import { passwordAgentPolicy } from "@opensesame/app-core/lib/password-agent/policy.js";
import {
  assertSafeRunName,
  validateRunTemplate,
} from "@opensesame/app-core/lib/password-agent/startup-env.js";

export interface OpInvocation {
  timeoutMs?: number | undefined;
  input?: string | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  account?: string | undefined;
  desktop?: boolean | undefined;
}

/** Diagnostics from a secret-bearing subprocess never cross this boundary. */
export function invokeOp(
  args: readonly string[],
  options: OpInvocation = {},
): Promise<string> {
  const env = { ...process.env, ...options.env };
  if (options.desktop) env.OP_SERVICE_ACCOUNT_TOKEN = undefined;
  const argv = options.account
    ? [...args, "--account", options.account]
    : [...args];
  return capture(
    resolveCredentialHelper("op", env),
    argv,
    env,
    options.input,
    options.timeoutMs,
  );
}

function capture(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input?: string,
  timeoutMs = 0,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: helperEnvironment(env),
      cwd: parse(process.execPath).root,
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    let output = "";
    let tooLarge = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length + chunk.length > 16_777_216) {
        tooLarge = true;
        child.kill();
      } else output += chunk;
    });
    child.on("error", () =>
      reject(
        new Error("Could not start credential helper; details suppressed."),
      ),
    );
    child.on("close", (code) => {
      if (code === 0 && !tooLarge) resolve(output);
      else reject(new Error("Credential helper failed; details suppressed."));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Input is exact bytes; creation normalization belongs to the core. */
export async function readPrivateInput(
  source: "stdin" | "clipboard",
): Promise<string> {
  let text: string;
  if (source === "stdin") {
    if (process.stdin.isTTY) throw new Error("Pipe the secret to --stdin.");
    process.stdin.setEncoding("utf8");
    text = "";
    for await (const chunk of process.stdin) {
      text += chunk;
      if (text.length > 16_777_216)
        throw new Error("Private input is too large.");
    }
  } else if (process.platform === "darwin") {
    text = await capture(resolveCredentialHelper("pbpaste"), [], process.env);
  } else if (process.platform === "win32") {
    text = await capture(
      resolveCredentialHelper("powershell"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write((Get-Clipboard -Raw))",
      ],
      process.env,
    );
  } else {
    throw new Error("Clipboard input requires macOS or Windows; use --stdin.");
  }
  if (!text.trim()) throw new Error("Private input is empty.");
  return text;
}

/** Files materializing plaintext are replaced atomically with owner-only mode. */
export async function writePrivateFile(
  target: string,
  content: string,
): Promise<void> {
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** A fixed node helper removes the provider token before the selected process. */
export function runOpChild(
  args: readonly string[],
  command: readonly string[],
  values: Readonly<Record<string, string>> = {},
  options: OpInvocation = {},
): Promise<number> {
  if (!command.length) throw new Error("A child command is required after --.");
  for (const name of Object.keys(values)) assertSafeRunName(name);
  const env = { ...process.env, ...options.env, ...values };
  if (options.desktop) env.OP_SERVICE_ACCOUNT_TOKEN = undefined;
  const script =
    "const {spawn}=require('node:child_process');delete process.env.OP_SERVICE_ACCOUNT_TOKEN;const c=spawn(process.argv[2],process.argv.slice(3),{cwd:process.argv[1],stdio:'inherit',env:process.env,shell:false});c.on('error',()=>process.exit(1));c.on('close',(code)=>process.exit(code===null?1:code));";
  const argv = [
    ...args,
    ...(options.account ? ["--account", options.account] : []),
    "--",
    process.execPath,
    "-e",
    script,
    process.cwd(),
    ...command,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCredentialHelper("op", env), argv, {
      env: helperEnvironment(env),
      cwd: parse(process.execPath).root,
      stdio: "inherit",
      shell: false,
    });
    child.on("error", () =>
      reject(
        new Error("Could not start credential helper; details suppressed."),
      ),
    );
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Windows normally searches the working directory before PATH; skip that search. */
export function resolveCredentialHelper(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let chosen: string | undefined;
  for (const directory of helperPathEntries(env)) {
    if (!trustedDirectory(directory)) continue;
    const candidate = join(
      directory,
      process.platform === "win32" ? `${name}.exe` : name,
    );
    try {
      const resolved = realpathSync(candidate);
      if (!statSync(resolved).isFile() || !trustedDirectory(dirname(resolved)))
        continue;
      accessSync(
        resolved,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      chosen = resolved;
    } catch {
      /* Missing or unusable PATH entries grant no trust. */
    }
  }
  if (!chosen) throw new Error("Credential helper was not found on PATH.");
  return chosen;
}

/** Remove interpreter preloads before credential-bearing helpers start. */
export function helperEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...input };
  const reserved = new Set(passwordAgentPolicy.credentialStartupEnvKeys);
  for (const key of Object.keys(env))
    if (reserved.has(key.toUpperCase())) delete env[key];
  env.PATH = (input.PATH ?? "")
    .split(delimiter)
    .filter(trustedDirectory)
    .join(delimiter);
  return env;
}

function helperPathEntries(env: NodeJS.ProcessEnv): string[] {
  const screened = helperEnvironment({ ...process.env, ...env }).PATH ?? "";
  return screened.split(delimiter);
}

function trustedDirectory(directory: string): boolean {
  const trimmed = directory.trim();
  if (!trimmed || !isAbsolute(trimmed)) return false;
  try {
    const resolved = realpathSync(trimmed);
    const cwd = realpathSync(process.cwd());
    if (resolved === cwd) return false;
    if (cwdUnderDirectory(cwd, resolved)) return false;
    if (worldWritableWithoutStickyBit(resolved)) return false;
    return true;
  } catch {
    return false;
  }
}

function cwdUnderDirectory(cwd: string, directory: string): boolean {
  if (process.platform === "win32") {
    const normalized = cwd.toLowerCase();
    const root = directory.toLowerCase();
    return normalized === root || normalized.startsWith(`${root}${sep}`);
  }
  return cwd === directory || cwd.startsWith(`${directory}${sep}`);
}

function worldWritableWithoutStickyBit(directory: string): boolean {
  if (process.platform === "win32") return false;
  try {
    const mode = lstatSync(directory).mode;
    return (mode & 0o002) !== 0 && (mode & 0o1000) === 0;
  } catch {
    return true;
  }
}

/** Execute only an owner-only snapshot of contents already screened by the core. */
export async function runEnvFileSnapshot(
  content: string,
  command: readonly string[],
  options: OpInvocation = {},
): Promise<number> {
  validateRunTemplate(content);
  const directory = await mkdtemp(join(tmpdir(), "opensesame-run-env-"));
  const file = join(directory, "environment");
  try {
    await chmod(directory, 0o700);
    await writeFile(file, content, { mode: 0o600, flag: "wx" });
    return await runOpChild(
      ["run", `--env-file=${file}`],
      command,
      {},
      options,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
