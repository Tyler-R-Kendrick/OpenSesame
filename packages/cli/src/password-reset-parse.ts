import { leftover, takeOption } from "./parse-options.js";
import type { GlobalFlags } from "./parse.js";

export type PasswordResetAction = "configure" | "run" | "resume" | "reconcile";

const ACTIONS = ["configure", "run", "resume", "reconcile"] as const;
const CONFIGURE_REQUIRED = [
  "origin",
  "recipe",
  "transport",
  "runtimeModule",
  "runtimeResource",
  "model",
  "modelBaseURL",
  "modelKeyEnv",
  "browser",
] as const;

export type PasswordResetCommand = {
  name: "password-reset";
  action: PasswordResetAction;
  config: string;
  origin?: string;
  itemId?: string;
  runId?: string;
  recipe?: string;
  transport?: "cdp" | "extension" | "proxy";
  runtimeModule?: string;
  runtimeResource?: string;
  model?: string;
  modelBaseURL?: string;
  modelKeyEnv?: string;
  browser?: string;
  maxSteps?: number;
  flags: GlobalFlags;
};

export function parsePasswordReset(
  args: string[],
  flags: GlobalFlags,
): PasswordResetCommand {
  const action = readAction(args.shift());
  const config = takeOption(args, "--config");
  if (!config) throw new Error("password-reset requires --config <file>");
  const maxSteps = readMaxSteps(args);
  const options = {
    origin: takeOption(args, "--origin"),
    itemId: takeOption(args, "--item"),
    runId: takeOption(args, "--run-id"),
    recipe: takeOption(args, "--recipe"),
    transport: takeOption(args, "--transport"),
    runtimeModule: takeOption(args, "--runtime"),
    runtimeResource: takeOption(args, "--runtime-resource"),
    model: takeOption(args, "--model"),
    modelBaseURL: takeOption(args, "--model-base-url"),
    modelKeyEnv: takeOption(args, "--model-key-env"),
    browser: takeOption(args, "--browser"),
    maxSteps,
  };
  validateTransport(options.transport);
  const command: PasswordResetCommand = {
    name: "password-reset",
    action,
    config,
    ...Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined),
    ),
    flags,
  };
  leftover(args, `password-reset ${action}`);
  validateCommand(command);
  return command;
}

function readAction(value: string | undefined): PasswordResetAction {
  const action = ACTIONS.find((candidate) => candidate === value);
  if (!action)
    throw new Error(
      "password-reset requires configure, run, resume, or reconcile",
    );
  return action;
}

function readMaxSteps(args: string[]): number | undefined {
  const rawSteps = takeOption(args, "--max-steps");
  const maxSteps = rawSteps === undefined ? undefined : Number(rawSteps);
  if (
    maxSteps !== undefined &&
    (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 80)
  )
    throw new Error("password-reset --max-steps must be between 1 and 80");
  return maxSteps;
}

function validateTransport(transport: string | undefined): void {
  if (
    transport !== undefined &&
    !["cdp", "extension", "proxy"].includes(transport)
  )
    throw new Error(
      "password-reset --transport must be cdp, extension, or proxy",
    );
}

function validateCommand(command: PasswordResetCommand): void {
  if (command.action === "configure") {
    const missing = CONFIGURE_REQUIRED.filter(
      (key) => command[key] === undefined,
    );
    if (missing.length > 0)
      throw new Error(
        `password-reset configure is missing ${missing.join(", ")}`,
      );
  } else if (
    (command.action === "resume" || command.action === "reconcile") &&
    !command.runId
  ) {
    throw new Error(`password-reset ${command.action} requires --run-id`);
  }
}
