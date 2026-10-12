/**
 * The grammar of `opensesame-id session` (ADR 0196): a terminal joins a live
 * session as a device, asks the owner for authority, and lists or uses the
 * connections the owner picked.
 *
 *   session [<link>] list   [options]
 *   session [<link>] invoke <connection> <operation> [--input key=value]...
 *
 * The link and the invite code are bearers: they may come from the
 * environment (`OPENSESAME_LIVE_LINK`, `OPENSESAME_LIVE_CODE`) so they stay
 * out of shell history. No message here repeats an argument's value.
 */

import {
  INPUT_MAX,
  WANT_MAX,
  isOperationId,
  readDeviceMessage,
} from "@opensesame/app-core/lib/live/device-messages.js";
import type { GlobalFlags } from "./parse.js";

export const DEFAULT_SESSION_TIMEOUT_SECONDS = 900;

/** The words a call hands an operation: keys of the device protocol's grammar. */
export type CallInput = Readonly<Record<string, string>>;
const MAX_SESSION_TIMEOUT_SECONDS = 24 * 60 * 60;

type SessionBase = {
  name: "session";
  /** The pasted link or its bare value; read (and refused) when it is used. */
  link: string;
  /** The invite code, or null in an open session. */
  code: string | null;
  /** What the owner is shown; null for the default. */
  deviceName: string | null;
  /** Connections to suggest to the owner: a hint, never a grant. */
  want: string[];
  /** How long the whole command may take. */
  timeoutSeconds: number;
  flags: GlobalFlags;
};

export type SessionCommand =
  | (SessionBase & { action: "list" })
  | (SessionBase & {
      action: "invoke";
      connection: string;
      operation: string;
      input: CallInput;
    });

/** Every occurrence of `--name <value>`, removed from `args`. */
function takeValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let at = args.indexOf(name); at !== -1; at = args.indexOf(name)) {
    const value = args[at + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`session ${name} needs a value`);
    values.push(value);
    args.splice(at, 2);
  }
  return values;
}

function takeOne(args: string[], name: string): string | undefined {
  const [first, ...more] = takeValues(args, name);
  if (more.length > 0) throw new Error(`session ${name} was given twice`);
  return first;
}

function fromEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Whether the device protocol accepts `id` as a connection id. */
function isConnectionId(id: string): boolean {
  return readDeviceMessage("dev.begin", { req: "r", want: [id] }) !== null;
}

function readWant(ids: readonly string[]): string[] {
  const want = [...new Set(ids)];
  if (want.length > WANT_MAX)
    throw new Error(`session names at most ${WANT_MAX} connections`);
  if (!want.every(isConnectionId))
    throw new Error("session was given a connection id the host cannot read");
  return want;
}

function readInput(pairs: readonly string[]): CallInput {
  const seen = new Map<string, string>();
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error("session --input needs key=value");
    const key = pair.slice(0, at);
    if (seen.has(key)) throw new Error("session --input repeats a key");
    seen.set(key, pair.slice(at + 1));
  }
  const input = Object.fromEntries(seen);
  const call = readDeviceMessage("dev.call", {
    req: "r",
    connection: "c",
    operation: "a",
    input,
  });
  if (call === null)
    throw new Error(
      `session --input takes up to ${INPUT_MAX} pairs, each a key of letters, digits, . _ - and a value under 2048 characters`,
    );
  return input;
}

function readTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SESSION_TIMEOUT_SECONDS;
  const seconds = Number(raw);
  if (
    raw.trim() === "" ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > MAX_SESSION_TIMEOUT_SECONDS
  )
    throw new Error(
      `session --timeout is a number of seconds up to ${MAX_SESSION_TIMEOUT_SECONDS}`,
    );
  return seconds;
}

/** An option nobody defined, named without any `=value` it carried. */
function unknownOption(arg: string): Error {
  const name = arg.split("=")[0] ?? "";
  return /^--[a-z][a-z-]{0,31}$/.test(name)
    ? new Error(`session does not take ${name}`)
    : new Error("session was given an option it does not take");
}

type Target = Readonly<{ link: string; action: "list" | "invoke" }>;

type Options = Readonly<{
  wanted: string[];
  pairs: string[];
  code: string | undefined;
  deviceName: string | undefined;
  timeoutSeconds: number;
}>;

/** Every option, removed from `args`; what is left is the words. */
function takeOptions(args: string[]): Options {
  const options = {
    wanted: takeValues(args, "--connection"),
    pairs: takeValues(args, "--input"),
    code: takeOne(args, "--code") ?? fromEnvironment("OPENSESAME_LIVE_CODE"),
    deviceName: takeOne(args, "--name"),
    timeoutSeconds: readTimeout(takeOne(args, "--timeout")),
  };
  const stray = args.find((arg) => arg.startsWith("--"));
  if (stray !== undefined) throw unknownOption(stray);
  return options;
}

/** The link, which the environment may hold, and the verb after it. */
function takeTarget(args: string[]): Target {
  const named = args[0] === "list" || args[0] === "invoke";
  const link = named ? fromEnvironment("OPENSESAME_LIVE_LINK") : args.shift();
  if (link === undefined)
    throw new Error(
      "session needs the live link: pass it first, or set OPENSESAME_LIVE_LINK",
    );
  const action = args.shift();
  if (action !== "list" && action !== "invoke")
    throw new Error("session needs list or invoke after the link");
  return { link, action };
}

function parseInvoke(
  base: SessionBase,
  options: Options,
  words: readonly string[],
): SessionCommand {
  const [connection, operation, ...extra] = words;
  if (connection === undefined || operation === undefined)
    throw new Error("session invoke needs <connection> and <operation>");
  if (extra.length > 0)
    throw new Error("session invoke takes no more arguments");
  if (!isConnectionId(connection))
    throw new Error(
      "session invoke was given a connection id the host cannot read",
    );
  if (!isOperationId(operation))
    throw new Error(
      "session invoke was given an operation the host cannot read",
    );
  return {
    ...base,
    action: "invoke",
    want: readWant([...options.wanted, connection]),
    connection,
    operation,
    input: readInput(options.pairs),
  };
}

export function parseSession(
  args: string[],
  flags: GlobalFlags,
): SessionCommand {
  const options = takeOptions(args);
  const { link, action } = takeTarget(args);
  const base: SessionBase = {
    name: "session",
    link,
    code: options.code ?? null,
    deviceName: options.deviceName ?? null,
    want: [],
    timeoutSeconds: options.timeoutSeconds,
    flags,
  };
  if (action === "invoke") return parseInvoke(base, options, args);
  if (options.pairs.length > 0)
    throw new Error("session list takes no --input");
  if (args.length > 0) throw new Error("session list takes no argument");
  return { ...base, action, want: readWant(options.wanted) };
}
