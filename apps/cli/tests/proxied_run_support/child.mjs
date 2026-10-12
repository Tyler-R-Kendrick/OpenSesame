// The agent child of a proxied run (apps/cli/tests/proxied_run_e2e.rs).
//
// It records what it was given, then makes the requests its plan names the
// way an unmodified HTTPS client does: through HTTPS_PROXY, trusting the run's
// CA from SSL_CERT_FILE. It sends the credential it was handed as `--token`
// on its command line, as `vercel --token "$VERCEL_TOKEN"` would.
//
//   node child.mjs <out dir> --token <value>
//
// <out dir>/plan.json: { "wait": bool, "lingerMs": number, "requests": [{
// label, host, method, path, authorization }] }. `authorization` is
// "surrogate" (Bearer <the --token>), null (none), { "bearer": "<literal>" }
// or { "bearerFile": "<path>" }. With "wait" the child writes <out dir>/ready
// and holds until <out dir>/go exists; with "lingerMs" it stays alive that
// long after its last request, as an agent waiting on its next step would.
// It writes its pid to <out dir>/pid. With "signals" it handles SIGTERM,
// SIGHUP and SIGINT by writing <out dir>/got-<NAME>: "record" then exits 0,
// "ignore" carries on, as a child that will not be asked twice does.

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import tls from "node:tls";

const [out, ...rest] = process.argv.slice(2);
const token = rest[rest.indexOf("--token") + 1] ?? "";

const lines = Object.entries(process.env).map(
  ([key, value]) => `${key}=${value}`,
);
writeFileSync(`${out}/env.txt`, `${lines.sort().join("\n")}\n`);
writeFileSync(`${out}/argv.json`, JSON.stringify(process.argv.slice(2)));

const plan = JSON.parse(readFileSync(`${out}/plan.json`, "utf8"));
writeFileSync(`${out}/pid`, String(process.pid));

if (plan.signals) {
  for (const name of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    process.on(name, () => {
      writeFileSync(`${out}/got-${name}`, "");
      if (plan.signals === "record") process.exit(0);
    });
  }
}

function bearer(authorization) {
  if (authorization === "surrogate") return `Bearer ${token}`;
  if (authorization?.bearer) return `Bearer ${authorization.bearer}`;
  if (authorization?.bearerFile) {
    return `Bearer ${readFileSync(authorization.bearerFile, "utf8").trim()}`;
  }
  return null;
}

// CONNECT through the run's proxy, then TLS to the host the proxy terminates.
function viaProxy({ host, method, path, authorization }) {
  const proxy = new URL(process.env.HTTPS_PROXY);
  const login = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  const credentials = Buffer.from(login).toString("base64");
  return new Promise((resolve) => {
    const failed = (error) =>
      resolve({ status: 0, body: "", error: error.code });
    const socket = net.connect(Number(proxy.port), proxy.hostname);
    let head = "";
    socket.on("error", failed);
    socket.on("data", function onHead(chunk) {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onHead);
      if (!head.startsWith("HTTP/1.1 200")) {
        resolve({ status: Number(head.split(" ")[1]), body: "" });
        return;
      }
      const secure = tls.connect({
        socket,
        servername: host,
        ca: readFileSync(process.env.SSL_CERT_FILE),
      });
      const auth = bearer(authorization);
      const header = auth ? `Authorization: ${auth}\r\n` : "";
      secure.on("error", failed);
      secure.write(
        `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\n${header}Accept: application/json\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      const parts = [];
      secure.on("data", (part) => parts.push(part));
      secure.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        const [response, body = ""] = text.split("\r\n\r\n");
        resolve({ status: Number(response.split(" ")[1]), body });
      });
    });
    socket.write(
      `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: Basic ${credentials}\r\n\r\n`,
    );
  });
}

if (plan.wait) {
  writeFileSync(`${out}/ready`, "");
  const deadline = Date.now() + 60_000;
  while (!existsSync(`${out}/go`) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

for (const request of plan.requests) {
  const { status, body, error } = await viaProxy(request);
  const line = JSON.stringify({ label: request.label, status, body, error });
  appendFileSync(`${out}/results.jsonl`, `${line}\n`);
}

if (plan.lingerMs) {
  await new Promise((resolve) => setTimeout(resolve, plan.lingerMs));
}
