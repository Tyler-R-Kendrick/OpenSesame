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
  emitHumanValue as outputHumanValue,
  emitMetadata as outputMetadata,
} from "./output.js";
import type { readPrivateInput, writePrivateFile } from "./parity-node.js";
import { exhausted, option, source, toggle } from "./parity-parse.js";
import { runLease, runPrivateRequest } from "./parity-request.js";
export interface ParityContext {
  assertCurrent: () => void;
  requestTransport?: Pick<RequestPorts, "addresses" | "send"> | undefined;
  args: string[];
  child: string[];
  scope: Scope;
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
  ctx.assertCurrent();
  const { args, scope, agent } = ctx;
  switch (verb) {
    case "request":
      return runPrivateRequest(ctx);
    case "lease":
      return runLease(ctx);
    case "find":
      if (!args.length || args.some((arg) => arg.startsWith("--")))
        throw new Error("find requires title queries.");
      print(ctx, await agent.find(args, scope));
      return 0;
    case "inventory":
      exhausted(args);
      print(ctx, { items: await agent.inventory(scope) });
      return 0;
    case "audit":
      exhausted(args);
      print(ctx, await agent.audit(scope));
      return 0;
    case "read": {
      const ref = required(args.shift(), "read requires op://reference.");
      exhausted(args);
      emitHumanValue(ctx, await agent.read(ref));
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
    ctx,
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
  print(ctx, await agent.password(target, await privateInput(inputSource)));
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
    ctx.assertCurrent();
    await privateFile(file, renderEnv(args.map(parseAssignment)));
    print(ctx, { written: true, file });
    return 0;
  }
  if (verb === "run") {
    exhausted(args);
    const content = await readFile(file, "utf8");
    ctx.assertCurrent();
    return agent.runFile(file, child, content);
  }
  if (verb !== "resolve")
    throw new Error("env requires write, resolve, or run.");
  const output = option(args, "--output");
  const inPlace = toggle(args, "--in-place");
  exhausted(args);
  if (inPlace === (output !== undefined))
    throw new Error("Choose exactly one of --output or --in-place.");
  const content = await readFile(file, "utf8");
  ctx.assertCurrent();
  const result = await agent.resolveEnv(content);
  ctx.assertCurrent();
  await privateFile(output ?? file, result.content);
  print(ctx, { resolved: result.count, file: output ?? file, plaintext: true });
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
  print(ctx, result);
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
      ctx,
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
    print(ctx, await service.setup(raw, store, target));
    return 0;
  }
  exhausted(args);
  if (verb === "status") print(ctx, await service.status(port, store));
  else if (verb === "recover")
    print(ctx, await service.recover(raw, store, name));
  else if (verb === "forget") print(ctx, await service.forget(store));
  else throw new Error("Unknown service-account command.");
  return 0;
}

function print<T>(ctx: ParityContext, value: T): void {
  ctx.assertCurrent();
  outputMetadata(value);
}
function emitHumanValue(ctx: ParityContext, value: string): void {
  ctx.assertCurrent();
  outputHumanValue(value);
}
