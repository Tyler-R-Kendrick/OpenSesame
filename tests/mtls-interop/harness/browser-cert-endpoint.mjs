/**
 * The disposable PKI and the supported mTLS endpoint the browser harness
 * (`apps/pages/scripts/verify-browser-cert.mjs`) drives.
 *
 * Certificates are minted by the system `openssl` CLI into a temporary
 * directory that the caller removes; nothing is committed and no system trust
 * store is touched. The endpoint is the Identity plane's real TLS listener
 * (`apps/control-plane/src/transport/listener.ts`) started through
 * `identity-listener.mts`, so a browser result here is a result about a
 * shipped endpoint rather than about a mock written for the occasion.
 *
 * If `tsx` is not installed the endpoint cannot start, and the caller must
 * report `not_executed` — never a pass.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OPENSSL = "/usr/bin/openssl";

function openssl(dir, args) {
  execFileSync(OPENSSL, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
}

function leaf(dir, name, eku, san) {
  const key = join(dir, `${name}.key`);
  const csr = join(dir, `${name}.csr`);
  const ext = join(dir, `${name}.ext`);
  const cert = join(dir, `${name}.pem`);
  openssl(dir, [
    "genpkey",
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-out",
    key,
  ]);
  openssl(dir, ["req", "-new", "-key", key, "-subj", `/CN=${name}`, "-out", csr]);
  writeFileSync(
    ext,
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${eku}\nsubjectAltName=${san}\nsubjectKeyIdentifier=hash\n`,
  );
  openssl(dir, [
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    join(dir, "root.pem"),
    "-CAkey",
    join(dir, "root.key"),
    "-CAcreateserial",
    "-days",
    "1",
    "-sha256",
    "-extfile",
    ext,
    "-out",
    cert,
  ]);
  return { cert, key };
}

/**
 * The paths [`makePki`] produces, without regenerating anything.
 *
 * The browser harness mints the PKI once and then re-executes itself with
 * `NODE_EXTRA_CA_CERTS` pointing at the root; re-minting in the child would
 * replace the file Node already read and every handshake would fail with
 * "self-signed certificate in certificate chain".
 */
export function pkiPaths(dir) {
  return {
    root: join(dir, "root.pem"),
    server: { cert: join(dir, "server.pem"), key: join(dir, "server.key") },
    enrolled: { cert: join(dir, "enrolled.pem"), key: join(dir, "enrolled.key") },
    unenrolled: {
      cert: join(dir, "unenrolled.pem"),
      key: join(dir, "unenrolled.key"),
    },
  };
}

/**
 * A root plus a server leaf for `localhost` and two client leaves: one the
 * binding set names, one it does not.
 */
export function makePki(dir) {
  mkdirSync(dir, { recursive: true });
  openssl(dir, [
    "ecparam",
    "-name",
    "prime256v1",
    "-genkey",
    "-noout",
    "-out",
    join(dir, "root.key"),
  ]);
  openssl(dir, [
    "req",
    "-x509",
    "-new",
    "-key",
    join(dir, "root.key"),
    "-sha256",
    "-days",
    "1",
    "-subj",
    "/CN=iop-browser-root",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-out",
    join(dir, "root.pem"),
  ]);
  return {
    root: join(dir, "root.pem"),
    server: leaf(dir, "server", "serverAuth", "DNS:localhost"),
    enrolled: leaf(
      dir,
      "enrolled",
      "clientAuth",
      "URI:spiffe://iop.test/browser/enrolled",
    ),
    unenrolled: leaf(
      dir,
      "unenrolled",
      "clientAuth",
      "URI:spiffe://iop.test/browser/unenrolled",
    ),
  };
}

/** A one-binding document naming only the enrolled identity. */
export function writeBindings(dir, operation) {
  const path = join(dir, "bindings.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        revision: 1,
        bindings: [
          {
            id: "browser",
            revision: 1,
            enabled: true,
            revoked: false,
            scope: "deployment",
            trust_profile: { name: "client_ca" },
            peer: { spiffe_id: "spiffe://iop.test/browser/enrolled" },
            service_principal: "svc:browser",
            purpose: "nats_auth_bridge",
            allowed_operations: [operation],
            allowed_audiences: ["host"],
            not_after: null,
            denied_thumbprints: [],
          },
        ],
      },
      null,
      2,
    ),
  );
  return path;
}

/**
 * Start the Identity plane's real TLS listener on an ephemeral loopback port.
 * Resolves to `{ port, stop() }`; rejects with a precise blocker when `tsx`
 * or the harness is missing.
 */
export async function startIdentityEndpoint({ repoRoot, pki, bindings, dir }) {
  const tsx = resolve(repoRoot, "apps/control-plane/node_modules/.bin/tsx");
  const script = resolve(
    repoRoot,
    "tests/mtls-interop/harness/identity-listener.mts",
  );
  if (!existsSync(tsx)) {
    throw new Error(
      `tsx is not installed at ${tsx} — the Identity endpoint cannot start (run pnpm install)`,
    );
  }
  if (!existsSync(script)) throw new Error(`missing harness: ${script}`);
  const log = join(dir, "identity-listener.log");
  const child = spawn(tsx, [script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_OPTIONS: "--max-old-space-size=8192",
      OPENSESAME_TLS_LISTEN: "127.0.0.1:0",
      OPENSESAME_TLS_POLICY: "mtls_required",
      OPENSESAME_TLS_CERT_FILE: pki.server.cert,
      OPENSESAME_TLS_KEY_FILE: pki.server.key,
      OPENSESAME_TLS_CLIENT_CA_FILE: pki.root,
      OPENSESAME_SERVICE_BINDINGS_FILE: bindings,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    writeFileSync(log, buffer);
  });
  child.stderr.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    writeFileSync(log, buffer);
  });
  const deadline = Date.now() + 90_000;
  for (;;) {
    const port = portOf(buffer);
    if (port) return { port, stop: () => child.kill("SIGTERM") };
    if (child.exitCode !== null) {
      child.kill("SIGKILL");
      throw new Error(`identity listener exited:\n${buffer}`);
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`identity listener never printed a port:\n${buffer}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function portOf(text) {
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const value = JSON.parse(line);
      if (Number.isInteger(value.port)) return value.port;
    } catch {
      // not the line we want
    }
  }
  return undefined;
}

/** Read the root PEM, so the caller can point `NODE_EXTRA_CA_CERTS` at it. */
export function rootPem(pki) {
  return readFileSync(pki.root, "utf8");
}
