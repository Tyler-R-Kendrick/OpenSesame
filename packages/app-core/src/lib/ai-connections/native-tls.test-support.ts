import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { tlsFetch } from "../native-s3-backup.test-support.js";
import { deferred } from "../secret-backends/runtime.test-support.js";
import type { CapturedAiRequest } from "./protocol.test-support.js";

function tlsMaterial() {
  const directory = mkdtempSync(join(tmpdir(), "ai-operation-tls-"));
  try {
    const keyFile = join(directory, "key.pem");
    const certFile = join(directory, "cert.pem");
    const args =
      "req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1".split(
        " ",
      );
    execFileSync("openssl", [...args, "-keyout", keyFile, "-out", certFile], {
      stdio: "ignore",
      timeout: 10000,
    });
    return {
      directory,
      key: readFileSync(keyFile),
      cert: readFileSync(certFile),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function aiNativeTlsFixture(
  answer: string,
  tokens: readonly string[],
) {
  const chatJson = JSON.stringify({
    choices: [{ message: { content: answer } }],
    usage: { prompt_tokens: 9, completion_tokens: 4 },
  });
  const responsesJson = JSON.stringify({
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: answer }] },
    ],
  });
  const tls = tlsMaterial();
  const { directory, cert } = tls;
  const requests: CapturedAiRequest[] = [];
  let held: ServerResponse | undefined;
  let hold = false;
  const progress = deferred<void>();
  const server = createServer(tls, (request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      requests.push({
        path: request.url ?? "",
        method: request.method ?? "",
        headers: request.headers,
        body,
      });
      if (
        !tokens.some(
          (token) => request.headers.authorization === `Bearer ${token}`,
        )
      ) {
        response.writeHead(401);
        response.end();
        return;
      }
      const parsed = JSON.parse(body);
      response.setHeader(
        "content-type",
        parsed.stream ? "text/event-stream" : "application/json",
      );
      if (parsed.stream) {
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`,
        );
        if (hold) {
          held = response;
          progress.resolve();
        } else response.end("data: [DONE]\n\n");
      } else
        response.end(
          request.url?.endsWith("/responses") ? responsesJson : chatJson,
        );
    });
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  return {
    requests,
    secureFetch: tlsFetch(cert),
    port: address.port,
    progress,
    hold() {
      hold = true;
    },
    finish() {
      held?.end("data: [DONE]\n\n");
    },
    async close() {
      held?.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
