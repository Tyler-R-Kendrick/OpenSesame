/** Runnable controlled loopback receiver. Provisioning keys are read from a private file, never argv/output. */
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { pathToFileURL } from "node:url";
import { createLogger } from "@opensesame/observability";
import { z } from "zod";
import {
  MAX_PACKAGE_BYTES,
  OBSERVATION_ROUTE,
  parseObservationReceiverProvision,
} from "../lib/credential-observation/protocol.js";
import {
  ObservationReferenceReceiver,
  referenceStateSchema,
} from "../lib/credential-observation/reference.js";
import {
  openPrivateObservationStateFile,
  readPrivateObservationFile,
} from "./credential-observation-files.js";
import { createPrivateObservationProvision } from "./credential-observation-provision.js";
const log = createLogger({ name: "credential-observation-receiver" });
export type ObservationReferenceServerHandle = {
  server: Server;
  close(): Promise<void>;
};
async function body(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const part of request) {
    bytes += part.length;
    if (bytes > MAX_PACKAGE_BYTES)
      throw new Error("Receiver body exceeds its bound.");
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts, bytes).toString("utf8");
}
export type ObservationReferenceServerInput = {
  provisionFile: string;
  stateFile: string;
  port: number;
};
export async function startObservationReferenceServer(
  input: ObservationReferenceServerInput,
) {
  const provision = parseObservationReceiverProvision(
    await readPrivateObservationFile(input.provisionFile, MAX_PACKAGE_BYTES),
  );
  const port = z.number().int().min(0).max(65535).parse(input.port);
  const files = await openPrivateObservationStateFile(input.stateFile);
  const receiver = new ObservationReferenceReceiver(provision, {
    async read() {
      try {
        return referenceStateSchema.parse(JSON.parse(await files.read()));
      } catch (error) {
        if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
          return null;
        throw error;
      }
    },
    async write(state) {
      const raw = JSON.stringify(referenceStateSchema.parse(state));
      await files.write(raw);
    },
  });
  let active = 0;
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "POST, OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");
    if (request.url !== OBSERVATION_ROUTE) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    if (request.headers.authorization || request.headers.cookie) {
      response.writeHead(400).end();
      return;
    }
    if (active >= 4) {
      response.writeHead(429).end();
      return;
    }
    active += 1;
    try {
      response.end(JSON.stringify(await receiver.receive(await body(request))));
    } catch {
      response
        .writeHead(400)
        .end(JSON.stringify({ error: "observation_rejected" }));
    } finally {
      active -= 1;
    }
  };
  const pending = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const work = serve(req, res).catch(() => {
      res.destroy();
    });
    pending.add(work);
    void work.then(() => pending.delete(work));
  });
  server.requestTimeout = 8000;
  server.headersTimeout = 8000;
  server.maxConnections = 32;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await files.close();
    throw error;
  }
  return {
    server,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.allSettled([...pending]);
      await files.close();
    },
  } satisfies ObservationReferenceServerHandle;
}
async function main(): Promise<void> {
  if (process.argv[2] === "--provision") {
    const [, path, origin, loopback] = process.argv.slice(2);
    if (
      !path ||
      !origin ||
      (loopback !== undefined && loopback !== "--allow-loopback")
    )
      throw new Error("Choose a private pairing file and fixed origin.");
    await createPrivateObservationProvision({
      path,
      origin,
      allowLoopback: loopback === "--allow-loopback",
    });
    log.info(
      "Independent receiver pairing saved privately. Import it through owner settings.",
    );
    return;
  }
  const [provisionFile, stateFile, rawPort = "18791"] = process.argv.slice(2);
  if (!provisionFile || !stateFile)
    throw new Error(
      "Usage: credential-observation-server PRIVATE_PROVISION_FILE PRIVATE_STATE_FILE [PORT]",
    );
  const running = await startObservationReferenceServer({
    provisionFile,
    stateFile,
    port: Number(rawPort),
  });
  const shutdown = () => {
    void running.close().catch(() => {
      log.error(
        "Receiver shutdown could not complete. Preserve private receipt state.",
      );
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  log.info("Controlled observation receiver listening on loopback.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    log.error(
      "Observation receiver could not start. Check private provisioning/state files and port.",
    );
    process.exitCode = 1;
  });
