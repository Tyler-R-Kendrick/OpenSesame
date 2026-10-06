import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import {
  handleControlledMcpRequest,
  handleInstalledControlledMcpRequest,
  parseControlledMcpRequest,
} from "@opensesame/app-core/lib/credential-canaries/index.js";
import { defaultStateDir } from "@opensesame/app-core/node/host.js";
import { parseCanaryConfiguration } from "./canary-config.js";
import { controlledDetectorStorage } from "./canary-detector.js";
import { bootHeadlessComposition } from "./headless-composition.js";
import { readSecurityFile } from "./security-files.js";
import { releaseVaultKv, useVaultKv } from "./vault-kv.js";

const MAX_REQUEST_BYTES = 4096;
type InvalidReply = {
  jsonrpc: "2.0";
  id: null;
  error: { code: number; message: string };
};
type McpReply =
  | NonNullable<Awaited<ReturnType<typeof handleControlledMcpRequest>>>
  | InvalidReply;
async function reply(output: Writable, value: McpReply): Promise<void> {
  if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, "drain");
}
/** Serialized, byte-bounded stdio validator. It never unwraps a real owner key. */
export async function serveCanary(
  configFile: string,
  stateDir?: string,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<number> {
  const config = parseCanaryConfiguration(
    await readSecurityFile(configFile, 4096),
  );
  await useVaultKv(stateDir ?? defaultStateDir());
  let line: number[] = [];
  try {
    await bootHeadlessComposition(stateDir ?? defaultStateDir(), config.tomb);
    for await (const chunk of input) {
      if (!(chunk instanceof Uint8Array))
        throw new Error("Canary stdio requires byte input.");
      for (const byte of chunk) {
        if (byte !== 10) {
          appendRequestByte(line, byte);
          continue;
        }
        await processLine(config, line, output);
        line = [];
      }
    }
    if (line.length) throw new Error("Incomplete canary request.");
    return 0;
  } finally {
    await releaseVaultKv();
  }
}

async function processLine(
  config: ReturnType<typeof parseCanaryConfiguration>,
  line: number[],
  output: Writable,
): Promise<void> {
  const response = await decodeLine(config, line);
  if (response !== null) await reply(output, response);
}
async function decodeLine(
  config: ReturnType<typeof parseCanaryConfiguration>,
  line: number[],
): Promise<
  Awaited<ReturnType<typeof handleControlledMcpRequest>> | InvalidReply
> {
  try {
    const request = parseControlledMcpRequest(
      Buffer.from(line).toString("utf8"),
    );
    if (config.validatorBinding)
      return await handleInstalledControlledMcpRequest(
        {
          binding: config.validatorBinding,
          storage: controlledDetectorStorage(config.validatorBinding),
          presentedId: config.artifact.presentedId,
        },
        request,
      );
    return await handleControlledMcpRequest(
      { tomb: config.tomb, artifact: config.artifact },
      request,
    );
  } catch {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Canary request rejected." },
    };
  }
}

function appendRequestByte(line: number[], byte: number): void {
  if (line.length >= MAX_REQUEST_BYTES)
    throw new Error("Canary request exceeds 4 KiB.");
  line.push(byte);
}
