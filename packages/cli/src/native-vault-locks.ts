/** Ordered original native custody. A successful OS lock remains DATA, never owner authentication. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { LockManagerLike } from "@opensesame/app-core/ports.js";
import { isFunction, overlapCast } from "@opensesame/os-domain";
import {
  type NativeDataProcess,
  nativeDataProcess,
} from "./native-data-process.js";
import type { NativeDataCommand } from "./native-data-wire.js";
export type NativeCustody = {
  credential?: NativeDataProcess;
  body?: NativeDataProcess;
  tomb?: string;
  writer?: boolean;
};
function plan(
  name: string,
  mode: "exclusive" | "shared",
  parent: NativeCustody,
) {
  const tomb =
    /^opensesame:vault-body:([A-Za-z0-9][A-Za-z0-9._-]{0,199})$/u.exec(
      name,
    )?.[1];
  const credential =
    name === "opensesame.retired-credentials" && mode === "exclusive";
  const ordered =
    tomb !== undefined &&
    mode === "exclusive" &&
    parent.credential !== undefined &&
    parent.body === undefined;
  let command: NativeDataCommand = { kind: "lease_try", logical: name, mode };
  if (credential) command = { kind: "credential_try" };
  if (ordered && tomb) command = { kind: "body_or_bootstrap_try", tomb };
  return { tomb, credential, ordered, command };
}
async function acquire(
  process: NativeDataProcess,
  command: NativeDataCommand,
  options: LockOptions,
  check: () => void,
) {
  while (true) {
    check();
    options.signal?.throwIfAborted();
    const reply = await process.request(command);
    if (reply.kind !== "available")
      throw new Error("Invalid native lock response.");
    if (reply.acquired || options.ifAvailable) return reply.acquired;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
class NativeVaultLocks {
  readonly context = new AsyncLocalStorage<NativeCustody>();
  readonly processes = new Set<NativeDataProcess>();
  closed = false;
  constructor(
    readonly stateDir: string,
    readonly executable?: string,
  ) {}
  check = () => {
    if (this.closed) throw new Error("Original native vault locks ended.");
  };
  async create() {
    this.check();
    const value = await nativeDataProcess(this.stateDir, this.executable);
    this.processes.add(value);
    return value;
  }
  request = async <T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    supplied?: LockGrantedCallback<T>,
  ): Promise<T> => {
    this.check();
    const callbackOnly = isFunction(overlapCast(optionsOrCallback));
    const options: LockOptions = callbackOnly
      ? {}
      : overlapCast(optionsOrCallback);
    const callback: LockGrantedCallback<T> | undefined = callbackOnly
      ? overlapCast(optionsOrCallback)
      : supplied;
    if (!callback || options.steal)
      throw new Error("Unsupported native vault lock request.");
    const parent = this.context.getStore() ?? {};
    const mode = options.mode ?? "exclusive";
    const selected = plan(name, mode, parent);
    const process = selected.ordered ? parent.credential : await this.create();
    if (!process)
      throw new Error("Original ordered native custody unavailable.");
    let acquired = false;
    try {
      acquired = await acquire(process, selected.command, options, this.check);
      this.check();
      options.signal?.throwIfAborted();
      if (!acquired) return overlapCast(await callback(null));
      if (selected.tomb && !selected.ordered)
        await process.request({
          kind: "capture_body_reader",
          tomb: selected.tomb,
        });
      const next: NativeCustody = { ...parent };
      if (selected.credential) next.credential = process;
      if (selected.tomb) {
        next.body = process;
        next.tomb = selected.tomb;
        next.writer = selected.ordered;
      }
      return await this.context.run(next, async () =>
        overlapCast(await callback({ name, mode })),
      );
    } finally {
      await this.release(process, selected.ordered, acquired);
    }
  };
  async release(
    process: NativeDataProcess,
    ordered: boolean,
    acquired: boolean,
  ) {
    if (ordered) {
      if (acquired) await process.request({ kind: "body_close" });
      return;
    }
    this.processes.delete(process);
    await process.close();
  }
  custody = () => {
    this.check();
    const value = this.context.getStore();
    if (!value) throw new Error("Original native custody is not held.");
    return value;
  };
  async close() {
    this.closed = true;
    await Promise.all([...this.processes].map((process) => process.close()));
    this.processes.clear();
  }
}
export function createNativeVaultLocks(stateDir: string, executable?: string) {
  const owner = new NativeVaultLocks(stateDir, executable);
  const locks: LockManagerLike = {
    request: overlapCast(owner.request),
    checkOriginal: owner.check,
    close: () => owner.close(),
  };
  return { locks, custody: owner.custody };
}
