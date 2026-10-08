import { readFile } from "node:fs/promises";
import type { CredentialStore } from "@opensesame/app-core/lib/password-agent/auth.js";
import {
  type DoctorContext,
  doctor,
} from "@opensesame/app-core/lib/password-agent/doctor.js";
import {
  type Destination,
  type PasswordAgent,
  type PasswordOptions,
  parseAssignment,
  renderEnv,
} from "@opensesame/app-core/lib/password-agent/index.js";
import type { RequestPorts } from "@opensesame/app-core/lib/password-agent/request.js";
import * as service from "@opensesame/app-core/lib/password-agent/service-account.js";
import type {
  PasswordAgentPort,
  Scope,
} from "@opensesame/app-core/lib/password-agent/transport.js";
import {
  emitHumanValue,
  emitStderrLine,
  emitMetadata as print,
} from "./output.js";
import type { readPrivateInput, writePrivateFile } from "./parity-node.js";
import { exhausted, option, source, toggle } from "./parity-parse.js";
import { runLease, runPrivateRequest } from "./parity-request.js";
import { assertHumanReveal, emitRevealReceipt } from "./reveal-gate.js";
export interface ParityContext {
  requestTransport?: Pick<RequestPorts, "addresses" | "send"> | undefined;
  args: string[];
  child: string[];
  scope: Scope;
  reveal: boolean;
  store: CredentialStore;
  raw: PasswordAgentPort;
  port: PasswordAgentPort;
  agent: PasswordAgent;
  privateInput: typeof readPrivateInput;
  privateFile: typeof writePrivateFile;
}
function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

export async function dispatchParity(
  verb: string,
  ctx: ParityContext,
): Promise<number> {
  const { args, scope, agent } = ctx;
  switch (verb) {
    case "request":
      return runPrivateRequest(ctx);
    case "lease":
      return runLease(ctx);
    case "find":
      if (!args.length || args.some((arg) => arg.startsWith("--")))
        throw new Error("find requires title queries.");
      print(await agent.find(args, scope));
      return 0;
    case "inventory":
      exhausted(args);
      print({ items: await agent.inventory(scope) });
      return 0;
    case "audit":
      exhausted(args);
      print(await agent.audit(scope));
      return 0;
    case "read": {
      const ref = required(args.shift(), "read requires op://reference.");
      exhausted(args);
      assertHumanReveal({
        verb: "read",
        reveal: ctx.reveal,
        desktop: Boolean(ctx.scope.desktop),
        reference: ref,
      });
      emitRevealReceipt({ verb: "read", reference: ref });
      emitHumanValue(await agent.read(ref));
      return 0;
    }
    case "create":
      return runCreate(ctx);
    case "password":
      return runPassword(ctx);
    case "run":
      return runChild(ctx);
    case "env":
      return runEnv(ctx);
    case "doctor":
      return runDoctor(ctx);
    case "service-account":
      return runService(ctx);
    default:
      throw new Error("Unknown parity command.");
  }
}

export async function runCreate(ctx: ParityContext): Promise<number> {
  const { args, scope, agent, privateInput } = ctx;
  const { vault, account } = scope;

  if (args.shift() !== "api-credential")
    throw new Error("create requires api-credential.");
  const title = required(option(args, "--title"), "--title is required.");
  const destination = required(vault, "--vault is required.");
  const inputSource = source(args);
  const url = option(args, "--url");
  const notes = option(args, "--notes");
  exhausted(args);
  const target: Destination = { title, vault: destination };
  if (account !== undefined) target.account = account;
  if (url !== undefined) target.url = url;
  if (notes !== undefined) target.notes = notes;
  print(
    await agent.createApiCredential(target, await privateInput(inputSource)),
  );
  return 0;
}

export async function runPassword(ctx: ParityContext): Promise<number> {
  const { args, scope, agent, privateInput } = ctx;
  const { vault, account } = scope;

  const item = required(args.shift(), "password requires an item.");
  const destination = required(vault, "--vault is required.");
  const inputSource = source(args);
  const apply = toggle(args, "--apply");
  const repairImportedFields = toggle(args, "--repair-imported-fields");
  exhausted(args);
  if (repairImportedFields && !apply)
    throw new Error("--repair-imported-fields requires --apply.");
  const target: PasswordOptions = {
    item,
    vault: destination,
    apply,
    repairImportedFields,
  };
  if (account !== undefined) target.account = account;
  print(await agent.password(target, await privateInput(inputSource)));
  return 0;
}

export async function runChild(ctx: ParityContext): Promise<number> {
  const { args, agent, child } = ctx;

  const assignments = [];
  while (args.includes("--env"))
    assignments.push(
      parseAssignment(
        required(
          option(args, "--env"),
          "--env requires a reference assignment.",
        ),
      ),
    );
  exhausted(args);
  if (!assignments.length)
    throw new Error("run requires --env NAME=op://reference.");
  return agent.run(assignments, child);
}

export async function runEnv(ctx: ParityContext): Promise<number> {
  const { args, agent, child, privateFile } = ctx;

  const verb = args.shift();
  const file = required(args.shift(), "env requires a file.");
  if (verb === "write") {
    if (!args.length)
      throw new Error("env write requires reference assignments.");
    await privateFile(file, renderEnv(args.map(parseAssignment)));
    print({ written: true, file });
    return 0;
  }
  if (verb === "run") {
    exhausted(args);
    return agent.runFile(file, child, await readFile(file, "utf8"));
  }
  if (verb !== "resolve")
    throw new Error("env requires write, resolve, or run.");
  assertHumanReveal({
    verb: "env-resolve",
    reveal: ctx.reveal,
    desktop: Boolean(ctx.scope.desktop),
  });
  emitStderrLine(
    "Deprecation: env resolve writes plaintext at rest; prefer `run --env-file` or `env run <file> -- <cmd>` (same `run` wrapper as `op run` / `infisical run`).",
  );
  const output = option(args, "--output");
  const inPlace = toggle(args, "--in-place");
  exhausted(args);
  if (inPlace === (output !== undefined))
    throw new Error("Choose exactly one of --output or --in-place.");
  emitRevealReceipt({ verb: "env-resolve" });
  const result = await agent.resolveEnv(await readFile(file, "utf8"));
  await privateFile(output ?? file, result.content);
  print({ resolved: result.count, file: output ?? file, plaintext: true });
  return 0;
}

export async function runDoctor(ctx: ParityContext): Promise<number> {
  const { args, scope, store, raw } = ctx;
  const { desktop } = scope;

  exhausted(args);
  let auth: DoctorContext["auth"] = "desktop app";
  if (!desktop && process.env.OP_SERVICE_ACCOUNT_TOKEN !== undefined)
    auth = "environment service account";
  else if (!desktop) {
    try {
      if (await store.loadSettings()) auth = "saved service account";
    } catch {
      auth = "saved service account (settings unreadable; use --desktop)";
    }
  }
  const result = await doctor(raw, {
    version: "0.1.0",
    platform: process.platform,
    runtime: process.version,
    auth,
  });
  print(result);
  return 0;
}

export async function runService(ctx: ParityContext): Promise<number> {
  const { args, scope, store, raw, port, privateInput } = ctx;
  const { vault, account } = scope;

  const verb = args.shift();
  const name = option(args, "--name") ?? "OpenSesame Automation";
  if (verb === "connect") {
    const inputSource = source(args);
    exhausted(args);
    print(
      await service.connect(raw, store, await privateInput(inputSource), name),
    );
    return 0;
  }
  if (verb === "setup") {
    const saveVault = required(
      option(args, "--save-vault"),
      "--save-vault is required.",
    );
    const createVault = toggle(args, "--create-vault");
    const write = toggle(args, "--write");
    const expiresIn = option(args, "--expires-in");
    exhausted(args);
    const target: service.SetupOptions = {
      name,
      vault: vault ?? "Automation",
      saveVault,
      createVault,
      write,
    };
    if (account !== undefined) target.account = account;
    if (expiresIn !== undefined) target.expiresIn = expiresIn;
    print(await service.setup(raw, store, target));
    return 0;
  }
  exhausted(args);
  if (verb === "status") print(await service.status(port, store));
  else if (verb === "recover") print(await service.recover(raw, store, name));
  else if (verb === "forget") print(await service.forget(store));
  else throw new Error("Unknown service-account command.");
  return 0;
}
