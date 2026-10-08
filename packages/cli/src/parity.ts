import { authenticatedPort } from "@opensesame/app-core/lib/password-agent/auth.js";
import { PasswordAgent } from "@opensesame/app-core/lib/password-agent/index.js";
import type { RequestPorts } from "@opensesame/app-core/lib/password-agent/request.js";
import type {
  PasswordAgentPort,
  Scope,
} from "@opensesame/app-core/lib/password-agent/transport.js";
import { z } from "zod";
import { guardedEffect, parityAuthority } from "./parity-authority.js";
import { createCredentialStore } from "./parity-credentials.js";
import {
  invokeOp,
  readPrivateInput,
  runEnvFileSnapshot,
  runOpChild,
  writePrivateFile,
} from "./parity-node.js";
import { type ParityCommand, option, toggle } from "./parity-parse.js";

import { dispatchParity } from "./parity-commands.js";

export interface ParityDependencies {
  requestTransport?: Pick<RequestPorts, "addresses" | "send">;
  parityPort?: PasswordAgentPort;
  privateInput?: typeof readPrivateInput;
  privateFile?: typeof writePrivateFile;
}
function childArgs(args: string[]): string[] {
  const separator = args.indexOf("--");
  if (separator < 0) throw new Error("The child command must follow --.");
  return args.splice(separator).slice(1);
}

export async function runParity(
  command: ParityCommand,
  deps: ParityDependencies = {},
): Promise<number> {
  const assertCurrent = parityAuthority();
  const args = [...command.args];
  const child =
    (command.verb === "run" || command.verb === "env") && args.includes("--")
      ? childArgs(args)
      : [];
  const desktop = toggle(args, "--desktop");
  const account = option(args, "--account");
  const vault = option(args, "--vault");
  const scope: Scope = {};
  if (desktop) scope.desktop = desktop;
  if (account !== undefined) scope.account = account;
  if (vault !== undefined) scope.vault = vault;
  const storage = createCredentialStore();
  const store = {
    storage: storage.storage,
    hasToken: guardedEffect(storage.hasToken, assertCurrent),
    loadToken: guardedEffect(storage.loadToken, assertCurrent),
    saveToken: guardedEffect(storage.saveToken, assertCurrent),
    removeToken: guardedEffect(storage.removeToken, assertCurrent),
    loadSettings: guardedEffect(storage.loadSettings, assertCurrent),
    saveSettings: guardedEffect(storage.saveSettings, assertCurrent),
    removeSettings: guardedEffect(storage.removeSettings, assertCurrent),
  };
  const selected: PasswordAgentPort = deps.parityPort ?? {
    invoke: invokeOp,
    run: runOpChild,
    runEnvFile: runEnvFileSnapshot,
  };
  const raw: PasswordAgentPort = {
    invoke: guardedEffect(selected.invoke, assertCurrent),
  };
  if (selected.run) raw.run = guardedEffect(selected.run, assertCurrent);
  if (selected.runEnvFile)
    raw.runEnvFile = guardedEffect(selected.runEnvFile, assertCurrent);
  if (selected.readMany)
    raw.readMany = guardedEffect(selected.readMany, assertCurrent);
  const port = authenticatedPort(
    raw,
    store,
    process.env.OP_SERVICE_ACCOUNT_TOKEN,
    desktop,
  );
  applyAccountScope(port, account);
  installReadMany(port);
  const agent = new PasswordAgent(port);
  const privateInput = guardedEffect(
    deps.privateInput ?? readPrivateInput,
    assertCurrent,
  );
  const privateFile = guardedEffect(
    deps.privateFile ?? writePrivateFile,
    assertCurrent,
  );
  return dispatchParity(command.verb, {
    assertCurrent,
    args,
    child,
    scope,
    store,
    raw,
    port,
    agent,
    privateInput,
    privateFile,
    requestTransport: deps.requestTransport && {
      addresses: guardedEffect(deps.requestTransport.addresses, assertCurrent),
      send: guardedEffect(deps.requestTransport.send, assertCurrent),
    },
  });
}

function installReadMany(port: PasswordAgentPort): void {
  if (!port.readMany)
    port.readMany = async (references) => {
      if (!references.length) return [];
      const env = Object.fromEntries(
        references.map((reference, index) => [
          `OPENSESAME_SECRET_${index}`,
          reference,
        ]),
      );
      // A fixed JSON protocol encoder writes into the captured private pipe.
      // This machine response is decoded below and never sent to CLI logging.
      const script =
        "require('node:fs').writeSync(1,JSON.stringify(Array.from({length:Number(process.argv[1])},(_,i)=>process.env['OPENSESAME_SECRET_'+i])))";
      const output = await port.invoke(
        [
          "run",
          "--no-masking",
          "--",
          process.execPath,
          "-e",
          script,
          String(references.length),
        ],
        { env },
      );
      return parseSecretBatch(output, references.length);
    };
}

function parseSecretBatch(output: string, count: number): string[] {
  try {
    const values = z.array(z.string()).parse(JSON.parse(output));
    if (values.length !== count) throw new Error("Invalid batch length");
    return values;
  } catch {
    throw new Error(
      "Provider returned an invalid secret batch; details suppressed.",
    );
  }
}

function applyAccountScope(
  port: PasswordAgentPort,
  account: string | undefined,
): void {
  if (account) {
    const invoke = port.invoke;
    port.invoke = (args, options) =>
      invoke(args, { ...options, account: options?.account ?? account });
  }
  if (account && port.runEnvFile) {
    const runFile = port.runEnvFile;
    port.runEnvFile = (content, command, options) =>
      runFile(content, command, {
        ...options,
        account: options?.account ?? account,
      });
  }
  if (account && port.run) {
    const run = port.run;
    port.run = (args, command, env) =>
      run([...args, "--account", account], command, env);
  }
}
