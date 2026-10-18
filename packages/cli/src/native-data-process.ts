/** Framed private child DATA. Lease ACKs never authenticate the human or vault root. */
import { spawn } from "node:child_process";
import {
  type NativeDataCommand,
  type NativeDataReply,
  nativeDataResponse,
} from "./native-data-wire.js";
export type { NativeDataReply } from "./native-data-wire.js";
import { nativeCompanionPath } from "./native-companion.js";
const MAX = 48 * 1024 * 1024;
export async function nativeDataProcess(state: string, executable?: string) {
  const child = spawn(
    executable ?? (await nativeCompanionPath()),
    ["vault", "node-data", "--state", state],
    { stdio: ["pipe", "pipe", "ignore"], shell: false },
  );
  let ended = false;
  let bytes = Buffer.alloc(0);
  let pending:
    | {
        resolve: (value: NativeDataReply) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  const fail = () => {
    ended = true;
    pending?.reject(new Error("Original native DATA process ended."));
    pending = undefined;
    child.kill();
  };
  child.on("error", fail);
  child.on("exit", fail);
  child.stdin.on("error", fail);
  child.stdout.on("data", (chunk: Buffer) => {
    if (ended || !pending || bytes.length + chunk.length > MAX + 4)
      return fail();
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length < 4) return;
    const length = bytes.readUInt32LE(0);
    if (length < 1 || length > MAX || bytes.length > length + 4) return fail();
    if (bytes.length < length + 4) return;
    try {
      const value = nativeDataResponse.parse(
        JSON.parse(bytes.subarray(4).toString("utf8")),
      );
      const waiting = pending;
      pending = undefined;
      bytes = Buffer.alloc(0);
      waiting.resolve(value.reply);
    } catch {
      fail();
    }
  });
  let tail: Promise<unknown> = Promise.resolve();
  function check() {
    if (ended) throw new Error("Original native DATA process ended.");
  }
  function request(op: NativeDataCommand): Promise<NativeDataReply> {
    const run = async () => {
      check();
      const data = Buffer.from(JSON.stringify({ v: 1, op }));
      if (data.length < 1 || data.length > MAX)
        throw new Error("Native DATA command exceeds its bound.");
      const header = Buffer.alloc(4);
      header.writeUInt32LE(data.length);
      return await new Promise<NativeDataReply>((resolve, reject) => {
        pending = { resolve, reject };
        child.stdin.write(Buffer.concat([header, data]), (error) => {
          if (error) fail();
        });
      });
    };
    const result = tail.then(run);
    tail = result.catch(() => {});
    return result;
  }
  return {
    check,
    request,
    async close() {
      if (ended) return;
      try {
        await request({ kind: "close" });
      } finally {
        ended = true;
        child.stdin.end();
        child.kill();
      }
    },
  };
}
export type NativeDataProcess = Awaited<ReturnType<typeof nativeDataProcess>>;
