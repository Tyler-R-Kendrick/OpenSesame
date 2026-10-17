import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseAssignment } from "@opensesame/app-core/lib/password-agent/index.js";
import { grantRunGrant } from "@opensesame/app-core/lib/password-agent/run-grant-grant.js";
import {
  type RunGrantBinding,
  type RunGrantRecord,
  describeRunGrant,
} from "@opensesame/app-core/lib/password-agent/run-grant.js";
import { emitMetadata } from "./output.js";
import type { ParityContext } from "./parity-commands.js";
import { openRunGrantStore } from "./parity-lease-node.js";
import { exhausted, option, toggle } from "./parity-parse.js";

function runGrantReceipt(record: RunGrantRecord) {
  return {
    ...record,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
  };
}

export function bindingFromRunArgs(args: string[]): {
  binding: RunGrantBinding;
  expiresIn: string;
  uses: number;
} {
  const expiresIn = option(args, "--expires-in") ?? "10m";
  const uses = Number(option(args, "--uses") ?? "1");
  const agentProxy = toggle(args, "--agent-proxy");
  const assignments = [];
  while (args.includes("--env"))
    assignments.push(parseAssignment(option(args, "--env") ?? ""));
  const mounts = [];
  while (args.includes("--mount"))
    mounts.push(parseAssignment(option(args, "--mount") ?? ""));
  const paths: string[] = [];
  while (args.includes("--paths")) paths.push(option(args, "--paths") ?? "");
  const methods: string[] = [];
  while (args.includes("--methods"))
    methods.push(option(args, "--methods") ?? "");
  exhausted(args);
  return {
    binding: describeRunGrant({
      assignments,
      mounts,
      agentProxy,
      paths,
      methods,
    }),
    expiresIn,
    uses,
  };
}

/** `lease approve-run`: the lease-approve human ceremony, for one exact run set. */
export async function approveRunGrant(ctx: ParityContext): Promise<number> {
  if (!process.stdin.isTTY || !process.stderr.isTTY || !ctx.scope.desktop)
    throw new Error(
      "Run-grant approval requires an interactive terminal and --desktop.",
    );
  const { binding, expiresIn, uses } = bindingFromRunArgs(ctx.args);
  let opened: Awaited<ReturnType<typeof openRunGrantStore>> | undefined;
  const store = async () => {
    if (!opened) opened = await openRunGrantStore();
    return opened;
  };
  try {
    const record = await grantRunGrant(
      binding,
      { expiresIn, uses },
      {
        approve: async () => humanRunApproval(binding, expiresIn, uses),
        store: {
          principal: async () => (await store()).principal(),
          insert: async (record) => (await store()).insert(record),
          get: async (id) => (await store()).get(id),
          claim: async (...args) => (await store()).claim(...args),
          revoke: async (...args) => (await store()).revoke(...args),
        },
        now: Date.now,
        newId: randomUUID,
      },
    );
    emitMetadata(runGrantReceipt(record));
  } finally {
    opened?.close();
  }
  return 0;
}

async function humanRunApproval(
  binding: RunGrantBinding,
  expiresIn: string,
  uses: number,
): Promise<boolean> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return (
      (await terminal.question(
        `Approve run grant for env ${JSON.stringify(binding.assignments)} mounts ${JSON.stringify(binding.mounts)} agentProxy ${binding.agentProxy} paths ${JSON.stringify(binding.paths)} methods ${JSON.stringify(binding.methods)}, ${uses} use(s), ${expiresIn}? Type approve: `,
      )) === "approve"
    );
  } finally {
    terminal.close();
  }
}

/** `lease run-list|run-status|run-revoke` metadata operations. */
export async function runGrantMetadata(
  verb: string,
  ctx: ParityContext,
): Promise<number> {
  const store = await openRunGrantStore();
  try {
    if (verb === "run-list") {
      exhausted(ctx.args);
      emitMetadata({ runGrants: (await store.list()).map(runGrantReceipt) });
    } else if (verb === "run-status") {
      const id = ctx.args.shift();
      exhausted(ctx.args);
      if (!id) throw new Error("Run grant id required.");
      emitMetadata(runGrantReceipt(await store.get(id)));
    } else if (verb === "run-revoke") {
      const id = ctx.args.shift();
      exhausted(ctx.args);
      if (!id) throw new Error("Run grant id required.");
      emitMetadata(
        runGrantReceipt(
          await store.revoke(id, await store.principal(), Date.now()),
        ),
      );
    } else throw new Error("Unknown run-grant command.");
  } catch {
    throw new Error(
      "Run grant metadata operation failed (details suppressed).",
    );
  } finally {
    store.close();
  }
  return 0;
}

/**
 * Claim one use of a grant for this exact run. Fails closed: an explicit
 * `--grant` never falls back to per-run approval.
 */
export async function claimRunGrantForRun(
  id: string,
  binding: RunGrantBinding,
): Promise<void> {
  const store = await openRunGrantStore();
  try {
    await store.claim(id, binding, await store.principal(), Date.now());
  } catch {
    throw new Error(
      "Run grant is invalid, expired, revoked, exhausted, or does not match this run (details suppressed).",
    );
  } finally {
    store.close();
  }
}
