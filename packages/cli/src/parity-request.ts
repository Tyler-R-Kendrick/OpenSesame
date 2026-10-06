import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { grantLease } from "@opensesame/app-core/lib/password-agent/lease-grant.js";
import type { LeaseRecord } from "@opensesame/app-core/lib/password-agent/lease.js";
import { inspectReference } from "@opensesame/app-core/lib/password-agent/lease.js";
import { leasedRequest } from "@opensesame/app-core/lib/password-agent/request-leased.js";
import {
  type RequestOptions,
  describeRequest,
} from "@opensesame/app-core/lib/password-agent/request.js";
import { emitMetadata } from "./output.js";
import type { ParityContext } from "./parity-commands.js";
import { openLeaseStore } from "./parity-lease-node.js";
import { exhausted, option } from "./parity-parse.js";
import { requestAddresses, sendPrivateRequest } from "./parity-request-node.js";
function options(args: string[]): RequestOptions {
  const url = args.shift();
  const reference = option(args, "--secret") ?? option(args, "--ref");
  if (!url || !reference)
    throw new Error("Request requires URL and --ref op://reference.");
  const result: RequestOptions = { url, reference };
  const header = option(args, "--header");
  const prefix = option(args, "--prefix");
  if (header !== undefined) result.header = header;
  if (prefix !== undefined) result.prefix = prefix;
  return result;
}
export async function runPrivateRequest(ctx: ParityContext): Promise<number> {
  const lease = option(ctx.args, "--lease");
  const config = options(ctx.args);
  exhausted(ctx.args);
  const request = {
    addresses: ctx.requestTransport?.addresses ?? requestAddresses,
    resolve: (ref: string) => ctx.agent.read(ref),
    send: ctx.requestTransport?.send ?? sendPrivateRequest,
  };
  if (!lease) throw new Error("Request requires a human-approved --lease.");
  const store = await openLeaseStore();
  try {
    const receipt = await leasedRequest(lease, config, {
      request,
      store,
      inspect: (ref) => inspectReference(ctx.port, ref),
      now: Date.now,
    });
    emitMetadata({
      ...receipt,
      lease: {
        ...receipt.lease,
        expiresAt: new Date(receipt.lease.expiresAt).toISOString(),
      },
    });
  } finally {
    store.close();
  }
  return 0;
}
export async function runLease(ctx: ParityContext): Promise<number> {
  const verb = ctx.args.shift();
  if (verb === "approve") return approve(ctx);
  const store = await openLeaseStore();
  try {
    if (verb === "list") {
      exhausted(ctx.args);
      emitMetadata({ leases: (await store.list()).map(leaseReceipt) });
    } else if (verb === "status") {
      const id = ctx.args.shift();
      exhausted(ctx.args);
      if (!id) throw new Error("Lease id required.");
      emitMetadata(leaseReceipt(await store.get(id)));
    } else if (verb === "revoke") {
      const id = ctx.args.shift();
      exhausted(ctx.args);
      if (!id) throw new Error("Lease id required.");
      emitMetadata(
        leaseReceipt(
          await store.revoke(id, await store.principal(), Date.now()),
        ),
      );
    } else throw new Error("Lease requires approve, list, status, or revoke.");
  } catch {
    throw new Error("Lease metadata operation failed (details suppressed).");
  } finally {
    store.close();
  }
  return 0;
}
async function approve(ctx: ParityContext): Promise<number> {
  if (!process.stdin.isTTY || !process.stderr.isTTY || !ctx.scope.desktop)
    throw new Error(
      "Lease approval requires an interactive terminal and --desktop.",
    );
  if (ctx.args[0] === "request") ctx.args.shift();
  const expiresIn = option(ctx.args, "--expires-in") ?? "10m";
  const uses = Number(option(ctx.args, "--uses") ?? "1");
  const config = options(ctx.args);
  exhausted(ctx.args);
  const binding = describeRequest(config);
  let opened: Awaited<ReturnType<typeof openLeaseStore>> | undefined;
  const store = async () => {
    if (!opened) opened = await openLeaseStore();
    return opened;
  };
  try {
    const record = await grantLease(
      binding,
      { expiresIn, uses },
      {
        approve: async () => humanApproval(config, binding, expiresIn, uses),
        inspect: (ref) => inspectReference(ctx.port, ref),
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
    emitMetadata(leaseReceipt(record));
  } finally {
    opened?.close();
  }
  return 0;
}
async function humanApproval(
  config: RequestOptions,
  binding: ReturnType<typeof describeRequest>,
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
        `Approve GET ${JSON.stringify(config.url)} (fingerprint ${binding.destinationFingerprint}), header ${binding.header} prefix ${JSON.stringify(binding.prefix)}, credential ${JSON.stringify(binding.reference)}, ${uses} use(s), ${expiresIn}? Type approve: `,
      )) === "approve"
    );
  } finally {
    terminal.close();
  }
}

function leaseReceipt(record: LeaseRecord) {
  return {
    ...record,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
  };
}
