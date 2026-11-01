import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cliAppIntegrationPolicy } from "@opensesame/app-core/lib/cli-app-integration/index.js";
import {
  asBufferSource,
  isJsonObject,
  isString,
  overlapCast,
  readString,
} from "@opensesame/os-domain";
import { tcpListenPort } from "./net-listen-port.js";

const ensurePath = cliAppIntegrationPolicy.daemonPaths.ensure;
const attestPath = cliAppIntegrationPolicy.daemonPaths.daemonAttest;

const DAEMON_ATTEST_LABEL = "opensesame-cli-app-daemon-attest.v1";

export const CLI_APP_INTEGRATION_DAEMON_PIN_PUBLIC_KEY_ENV =
  "OPENSESAME_CLI_APP_INTEGRATION_DAEMON_PIN_PUBLIC_KEY_SPKI_B64";

export interface CliAppIntegrationFakeDaemon {
  baseUrl: string;
  close: () => Promise<void>;
}

export interface CliAppIntegrationFakeDaemonEnv {
  env: NodeJS.ProcessEnv;
  close: () => Promise<void>;
}

interface JourneyFakeDaemonPin {
  privateKey: CryptoKey;
  publicKeySpkiB64: string;
}

let journeyFakeDaemonPinPromise: Promise<JourneyFakeDaemonPin> | null = null;

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function daemonAttestMessage(nonce: string): Uint8Array {
  const label = new TextEncoder().encode(DAEMON_ATTEST_LABEL);
  const nonceBytes = new TextEncoder().encode(nonce);
  const message = new Uint8Array(label.byteLength + 1 + nonceBytes.byteLength);
  message.set(label, 0);
  message[label.byteLength] = 0;
  message.set(nonceBytes, label.byteLength + 1);
  return message;
}

async function journeyFakeDaemonPin(): Promise<JourneyFakeDaemonPin> {
  if (!journeyFakeDaemonPinPromise) {
    journeyFakeDaemonPinPromise = (async () => {
      const pair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
      return {
        privateKey: pair.privateKey,
        publicKeySpkiB64: b64urlEncode(new Uint8Array(spki)),
      };
    })();
  }
  return journeyFakeDaemonPinPromise;
}

/** SPKI for `verifyLocalDaemonForCliAppIntegration` against the journey fake daemon. */
export async function journeyFakeDaemonPinPublicKeySpkiB64(): Promise<string> {
  const pin = await journeyFakeDaemonPin();
  return pin.publicKeySpkiB64;
}

/** Loopback stub for journey tests; not shipped in production code. */
/** Journey env: loopback fake daemon, no seam/listen overrides. */
export async function envWithFakeCliAppIntegrationDaemon(
  base: NodeJS.ProcessEnv,
): Promise<CliAppIntegrationFakeDaemonEnv> {
  const fakeDaemon = await startCliAppIntegrationFakeDaemon();
  const pinSpki = await journeyFakeDaemonPinPublicKeySpkiB64();
  const env: NodeJS.ProcessEnv = {
    ...base,
    OPENSESAME_DAEMON_API: fakeDaemon.baseUrl,
    [CLI_APP_INTEGRATION_DAEMON_PIN_PUBLIC_KEY_ENV]: pinSpki,
  };
  Reflect.deleteProperty(env, "OPENSESAME_DAEMON_LISTEN");
  Reflect.deleteProperty(env, "OPENSESAME_CLI_APP_INTEGRATION_SEAM");
  return { env, close: fakeDaemon.close };
}

const pinProbeVerb = cliAppIntegrationPolicy.daemonPinProbeVerb;

export async function startCliAppIntegrationFakeDaemon(): Promise<CliAppIntegrationFakeDaemon> {
  const pin = await journeyFakeDaemonPin();
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        const payload = JSON.stringify({ status: "ok" });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
        return;
      }
      if (req.method === "POST" && req.url === attestPath) {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => {
          chunks.push(chunk);
        });
        req.on("end", () => {
          void (async () => {
            let signatureB64 = "";
            try {
              const parsed = overlapCast(
                JSON.parse(Buffer.concat(chunks).toString("utf8")),
              );
              const nonce = isJsonObject(parsed)
                ? readString(parsed.nonce)
                : undefined;
              if (nonce) {
                const message = daemonAttestMessage(nonce);
                const sig = await crypto.subtle.sign(
                  { name: "ECDSA", hash: "SHA-256" },
                  pin.privateKey,
                  asBufferSource(message),
                );
                signatureB64 = b64urlEncode(new Uint8Array(sig));
              }
            } catch {
              signatureB64 = "";
            }
            const payload = JSON.stringify({ signatureB64 });
            res.writeHead(200, {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            });
            res.end(payload);
          })();
        });
        return;
      }
      if (req.method === "POST" && req.url === ensurePath) {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => {
          chunks.push(chunk);
        });
        req.on("end", () => {
          let status = "approved";
          try {
            const parsed = overlapCast(
              JSON.parse(Buffer.concat(chunks).toString("utf8")),
            );
            const verb = isJsonObject(parsed) ? parsed.verb : undefined;
            if (isString(verb) && verb === pinProbeVerb) {
              status = "pending";
            }
          } catch {
            status = "denied";
          }
          const payload = JSON.stringify({ status });
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          });
          res.end(payload);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const bound: AddressInfo = overlapCast(server.address());
      const port = tcpListenPort(bound);
      if (port === null) {
        reject(new Error("fake daemon has no listen address"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
    server.on("error", reject);
  });
}
