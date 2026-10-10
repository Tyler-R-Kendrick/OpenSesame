import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
type ProcessResult = { code: number; stdout: string; stderr: string };
export async function nativeProcessFixture() {
  const ROOT = resolve(import.meta.dirname, "../../../../..");
  async function cli(
    args: string[],
    input?: string,
    cwd = ROOT,
  ): Promise<ProcessResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(
        process.env.OPENSESAME_NATIVE_BINARY ??
          resolve(
            process.env.CARGO_TARGET_DIR ??
              resolve(process.env.HOME ?? "", ".cache/packages/cargo-target"),
            "debug/opensesame",
          ),
        ["password-agent", ...args],
        { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (value) => {
        stdout += String(value);
      });
      child.stderr.on("data", (value) => {
        stderr += String(value);
      });
      child.on("error", reject);
      child.on("close", (code) =>
        resolveResult({ code: code ?? 1, stdout, stderr }),
      );
      child.stdin.end(input);
    });
  }
  async function calls() {
    return (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) =>
        z
          .object({ args: z.array(z.string()), token: z.string().optional() })
          .parse(JSON.parse(line)),
      );
  }
  const directory = await mkdtemp(join(tmpdir(), "opensesame-parity-"));
  const database = join(directory, "db.json");
  const log = join(directory, "calls.jsonl");
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "op"),
    `#!${process.execPath}\n${(await readFile(resolve(import.meta.dirname, "op.cjs"), "utf8")).split("\n").slice(1).join("\n")}`,
  );
  await chmod(join(bin, "op"), 0o700);
  await writeFile(
    join(bin, "secret-tool"),
    `#!${process.execPath}\nconst fs=require('node:fs');const p=process.env.PARITY_TOKEN_FILE;const action=process.argv[2];if(action==='lookup'){if(!fs.existsSync(p))process.exit(1);process.stdout.write(fs.readFileSync(p));}else if(action==='store'){fs.writeFileSync(p,fs.readFileSync(0),{mode:0o600});}else if(action==='clear'){fs.rmSync(p,{force:true});}`,
  );
  await chmod(join(bin, "secret-tool"), 0o700);
  await writeFile(log, "");
  await seed(database);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    OPENSESAME_STATE_DIR: join(directory, "state"),
    XDG_CONFIG_HOME: join(directory, "config"),
    PARITY_TOKEN_FILE: join(directory, "token"),
    PARITY_DB: database,
    PARITY_LOG: log,
    OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN,
    PARITY_FAIL_READ: process.env.PARITY_FAIL_READ,
    PARITY_STUCK_VERSION: process.env.PARITY_STUCK_VERSION,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    OPENSESAME_CLI_APP_INTEGRATION_SEAM: "approve",
  };

  env.OP_SERVICE_ACCOUNT_TOKEN = undefined;
  env.PARITY_FAIL_READ = undefined;
  env.PARITY_STUCK_VERSION = undefined;
  return { directory, database, env, cli, calls };
}

async function seed(database: string) {
  await writeFile(
    database,
    JSON.stringify({
      items: [
        {
          id: "a".repeat(26),
          title: "Database",
          category: "LOGIN",
          vault: { id: "b".repeat(26), name: "Automation" },
          tags: [],
          urls: [
            {
              href: "https://example.com/oauth/callback?secret=canary#secret",
            },
          ],
          updated_at: "2010-01-01T00:00:00Z",
          fields: [
            {
              id: "password",
              purpose: "PASSWORD",
              type: "CONCEALED",
              value: "original",
              reference: "op://Automation/Database/password",
            },
          ],
        },
      ],
    }),
  );
}
