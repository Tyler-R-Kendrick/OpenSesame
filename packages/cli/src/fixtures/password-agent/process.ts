import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { envWithoutAgentContext } from "../../reveal-gate.js";

const InvocationSchema = z.object({
  args: z.array(z.string()),
  token: z.string().optional(),
  account: z.string().optional(),
});
interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function processFixture() {
  const ROOT = resolve("../..");
  async function cli(args: string[], input?: string): Promise<ProcessResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          resolve("node_modules/tsx/dist/loader.mjs"),
          "packages/cli/src/bin.ts",
          ...args,
        ],
        { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] },
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
  async function seed() {
    await writeFile(
      database,
      JSON.stringify({
        items: [
          {
            id: "a".repeat(26),
            title: "Database",
            version: 1,
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
  async function calls() {
    return (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => InvocationSchema.parse(JSON.parse(line)));
  }
  const directory = await mkdtemp(join(tmpdir(), "opensesame-parity-"));
  const database = join(directory, "db.json");
  const log = join(directory, "calls.jsonl");
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "op"),
    `#!${process.execPath}\n${(await readFile(resolve("src/fixtures/password-agent/op.cjs"), "utf8")).split("\n").slice(1).join("\n")}`,
  );
  await chmod(join(bin, "op"), 0o700);
  await writeFile(log, "");
  await seed();
  const env: NodeJS.ProcessEnv = envWithoutAgentContext({
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    OPENSESAME_STATE_DIR: join(directory, "state"),
    PARITY_DB: database,
    PARITY_LOG: log,
    OP_SERVICE_ACCOUNT_TOKEN: undefined,
  });

  return { directory, database, env, cli, calls };
}
