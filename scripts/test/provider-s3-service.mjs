/** Pinned official MinIO on loopback: the browser talks directly to this provider. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { X509Certificate, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { boundPort } from "./provider-auth-services.mjs";

const RELEASE = "RELEASE.2025-09-07T16-13-09Z";
const PACKAGE = "minio_20250907161309.0.0_amd64.deb";
const SHA256 =
  "eeda08f699f6592d1b868ac8bda864ae2cacdb5ee1b888663366e8c8ff566249";

function fixtureBinary(out) {
  if (process.env.PROVIDER_S3_MINIO) {
    assert.equal(
      createHash("sha256")
        .update(fs.readFileSync(process.env.PROVIDER_S3_MINIO))
        .digest("hex"),
      "7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f",
      "Pinned MinIO executable",
    );
    return process.env.PROVIDER_S3_MINIO;
  }
  const archive = path.join(out, PACKAGE);
  fs.mkdirSync(out, { recursive: true });
  if (!fs.existsSync(archive))
    execFileSync("curl", [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--max-time",
      "120",
      `https://github.com/minio/minio/releases/download/${RELEASE}/${PACKAGE}`,
      "-o",
      archive,
    ]);
  assert.equal(
    createHash("sha256").update(fs.readFileSync(archive)).digest("hex"),
    SHA256,
    "Pinned official MinIO package",
  );
  execFileSync("dpkg-deb", ["-x", archive, path.join(out, "package")]);
  return path.join(out, "package/usr/local/bin/minio");
}
function certificate(out) {
  const tls = path.join(out, "tls");
  fs.mkdirSync(tls, { recursive: true, mode: 0o700 });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      path.join(tls, "private.key"),
      "-out",
      path.join(tls, "public.crt"),
    ],
    { stdio: "ignore" },
  );
  const cert = fs.readFileSync(path.join(tls, "public.crt"));
  const publicKey = new X509Certificate(cert).publicKey;
  const spki = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  return { tls, cert, spki };
}
function request(url, init, ca) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers)),
        ca,
        timeout: 15000,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("MinIO fixture timeout")));
    req.end(init.body);
  });
}
async function signer(root, out) {
  const require = createRequire(path.join(root, "apps/pages/package.json"));
  const esbuild = createRequire(require.resolve("vite/package.json"))(
    "esbuild",
  );
  const file = path.join(out, "fixture-signer.mjs");
  await esbuild.build({
    stdin: {
      resolveDir: path.join(root, "packages/app-core"),
      contents: `import { Redacted } from "effect"; import {signS3, EMPTY_PAYLOAD} from "./src/lib/secret-fs/s3-sigv4.ts"; export { EMPTY_PAYLOAD }; export function signFixture(input) { return signS3({...input, credentials: {accessKeyId: input.accessKey, secretAccessKey: Redacted.make(input.secretKey)}}); }`,
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: file,
  });
  return import(pathToFileURL(file).href);
}
async function ready(endpoint, cert, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error("MinIO fixture exited before readiness");
    try {
      if ((await request(`${endpoint}/minio/health/live`, {}, cert)) === 200)
        return;
    } catch {
      /* Local process is still opening its listener. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("MinIO fixture did not become ready");
}
async function provision(signed, endpoint, cert, accessKey, secretKey) {
  const bucket = "browser-verified-bucket";
  const create = signed.signFixture({
    method: "PUT",
    url: new URL(`${endpoint}/${bucket}`),
    payloadHash: signed.EMPTY_PAYLOAD,
    region: "us-east-1",
    accessKey,
    secretKey,
  });
  assert.equal(
    await request(create.url, { method: "PUT", headers: create.headers }, cert),
    200,
  );
  // A bucket directory is a real provider object, so empty-body hashing stays reusable.
  const object = signed.signFixture({
    method: "PUT",
    url: new URL(`${endpoint}/${bucket}/fixture/sealed-document`),
    payloadHash: signed.EMPTY_PAYLOAD,
    region: "us-east-1",
    accessKey,
    secretKey,
  });
  assert.equal(
    await request(object.url, { method: "PUT", headers: object.headers }, cert),
    200,
  );
  return bucket;
}
export async function startProviderS3({ root, out, origin }) {
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const binary = fixtureBinary(path.join(out, "fixtures"));
  const version = execFileSync(binary, ["--version"], {
    encoding: "utf8",
  }).split("\n")[0];
  assert.ok(version.includes(RELEASE), "Expected pinned MinIO release");
  const run = fs.mkdtempSync(path.join(out, "minio-run-"));
  const cert = certificate(run);
  const port = await boundPort();
  const consolePort = await boundPort();
  const endpoint = `https://127.0.0.1:${port}`;
  const accessKey = `fixture${randomBytes(8).toString("hex")}`;
  const secretKey = randomBytes(32).toString("hex");
  const log = fs.openSync(path.join(out, "minio.log"), "w", 0o600);
  const child = spawn(
    binary,
    [
      "server",
      path.join(run, "data"),
      "--address",
      `127.0.0.1:${port}`,
      "--console-address",
      `127.0.0.1:${consolePort}`,
      "--certs-dir",
      cert.tls,
      "--quiet",
    ],
    {
      env: {
        ...process.env,
        MINIO_ROOT_USER: accessKey,
        MINIO_ROOT_PASSWORD: secretKey,
        MINIO_API_CORS_ALLOW_ORIGIN: origin,
      },
      stdio: ["ignore", log, log],
    },
  );
  fs.closeSync(log);
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (child.exitCode === null) {
      const stopped = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await stopped;
    }
    fs.rmSync(run, { recursive: true, force: true });
  }
  try {
    await ready(endpoint, cert.cert, child);
    const signed = await signer(root, out);
    const bucket = await provision(
      signed,
      endpoint,
      cert.cert,
      accessKey,
      secretKey,
    );
    return {
      endpoint,
      bucket,
      accessKey,
      secretKey,
      spki: cert.spki,
      version,
      packageSha256: SHA256,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
