/** Real Headscale + embedded DERP + native userspace peer; no SDK/network mocks. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  fixturePeerTLS,
  fixtureTls,
  forwardingEdge,
  proofServer,
} from "./tailnet-connect-fixture-network.mjs";
import {
  command,
  fixtureBinaries,
  ownedProcess,
  waitUntil,
} from "./tailnet-connect-fixture-process.mjs";

const User = z.object({ id: z.union([z.string(), z.number()]) });
const Enrollment = z.object({ key: z.string().min(1) });
const NativeStatus = z.object({
  BackendState: z.string(),
  TailscaleIPs: z.array(z.string()),
});
const NativePeers = z.object({
  Peer: z
    .record(
      z.string(),
      z.object({
        TailscaleIPs: z.array(z.string()).nullish(),
        Online: z.boolean().nullish(),
      }),
    )
    .nullish(),
});

async function writeConfiguration(directory, ports) {
  const path = (name) => join(directory, name);
  await writeFile(
    path("policy.json"),
    JSON.stringify({
      acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
    }),
  );
  await writeFile(
    path("derp.yaml"),
    `regions:
  900:
    regionid: 900
    regioncode: fixture
    regionname: Browser fixture DERP
    nodes:
      - name: fixture900
        regionid: 900
        hostname: derp.fixture.test
        ipv4: 127.0.0.1
        stunport: ${ports.stun}
        derpport: ${ports.derp}
        forcehttp: false
`,
  );
  // JSON is valid YAML; paths never pass through a shell or YAML interpolation.
  const config = {
    server_url: `http://localhost:${ports.control}`,
    listen_addr: `127.0.0.1:${ports.headscale}`,
    metrics_listen_addr: "127.0.0.1:0",
    grpc_listen_addr: "127.0.0.1:0",
    noise: { private_key_path: path("noise.key") },
    prefixes: {
      v4: "100.64.0.0/10",
      v6: "fd7a:115c:a1e0::/48",
      allocation: "sequential",
    },
    derp: {
      server: {
        enabled: true,
        region_id: 900,
        region_code: "fixture",
        region_name: "Browser fixture DERP",
        stun_listen_addr: `127.0.0.1:${ports.stun}`,
        private_key_path: path("headscale-derp.key"),
        automatically_add_embedded_derp_region: false,
        ipv4: "127.0.0.1",
      },
      urls: [],
      paths: [path("derp.yaml")],
      auto_update_enabled: false,
    },
    disable_check_updates: true,
    database: { type: "sqlite", sqlite: { path: path("db.sqlite") } },
    policy: { mode: "file", path: path("policy.json") },
    dns: {
      magic_dns: true,
      base_domain: "browser-fixture.test",
      override_local_dns: false,
      nameservers: { global: [] },
    },
    unix_socket: path("hs.sock"),
    unix_socket_permission: "0700",
  };
  await writeFile(path("config.yaml"), JSON.stringify(config));
  return path("config.yaml");
}

async function enrollNative({
  binaries,
  directory,
  config,
  controlUrl,
  tls,
  cleanups,
}) {
  const user = User.parse(
    JSON.parse(
      await command(binaries.headscale, [
        "-c",
        config,
        "users",
        "create",
        "browser",
        "--output",
        "json",
      ]),
    ),
  );
  const enrollment = Enrollment.parse(
    JSON.parse(
      await command(binaries.headscale, [
        "-c",
        config,
        "preauthkeys",
        "create",
        "--user",
        String(user.id),
        "--reusable",
        "--expiration",
        "1h",
        "--output",
        "json",
      ]),
    ),
  );
  const keyPath = join(directory, "preauth-key.txt");
  await writeFile(keyPath, enrollment.key, { mode: 0o600 });
  const socket = join(directory, "peer.sock");
  const state = join(directory, "peer");
  await mkdir(state);
  const env = {
    ...process.env,
    NO_PROXY: "localhost,127.0.0.1,derp.fixture.test",
    no_proxy: "localhost,127.0.0.1,derp.fixture.test",
    SSL_CERT_FILE: tls.caPath,
    TS_DISABLE_LOGTAIL: "true",
    TS_DEBUG_ALWAYS_USE_DERP: "true",
  };
  cleanups.push(
    await ownedProcess(
      binaries.tailscaled,
      [
        "--tun=userspace-networking",
        `--statedir=${state}`,
        `--socket=${socket}`,
        "--port=0",
      ],
      join(directory, "peer.log"),
      env,
    ),
  );
  const cli = (args) =>
    command(binaries.tailscale, [`--socket=${socket}`, ...args], { env });
  await waitUntil(
    async () => Boolean(await cli(["status", "--json"])),
    "native socket",
  );
  await cli([
    "up",
    `--login-server=${controlUrl}`,
    `--auth-key=file:${keyPath}`,
    "--hostname=native-fixture-peer",
    "--accept-dns=false",
  ]);
  let status;
  await waitUntil(async () => {
    status = NativeStatus.parse(JSON.parse(await cli(["status", "--json"])));
    return status.BackendState === "Running" && status.TailscaleIPs.length > 0;
  }, "native peer Running");
  return { authKey: enrollment.key, address: status.TailscaleIPs[0], cli };
}

async function closeAll(cleanups) {
  const failures = [];
  for (const close of cleanups.toReversed()) {
    try {
      await close();
    } catch {
      failures.push("fixture cleanup failed");
    }
  }
  if (failures.length) throw new Error(failures.join("; "));
}

async function peerServices({
  native,
  directory,
  ports,
  tls,
  cleanups,
  peerTLS,
}) {
  const proof = await proofServer(ports.peer);
  cleanups.push(proof.close);
  await native.cli([
    "serve",
    "--bg",
    "--tcp=8080",
    `tcp://127.0.0.1:${ports.peer}`,
  ]);
  if (!peerTLS) return { proof };
  const certificates = await fixturePeerTLS(directory, native.address);
  const trusted = await proofServer(ports.peer + 1, certificates.trusted);
  cleanups.push(trusted.close);
  await native.cli([
    "serve",
    "--bg",
    "--tcp=8443",
    `tcp://127.0.0.1:${ports.peer + 1}`,
  ]);
  const wrongHostname = await proofServer(
    ports.peer + 2,
    certificates.wrongHostname,
  );
  cleanups.push(wrongHostname.close);
  await native.cli([
    "serve",
    "--bg",
    "--tcp=8444",
    `tcp://127.0.0.1:${ports.peer + 2}`,
  ]);
  const host = native.address.includes(":")
    ? `[${native.address}]`
    : native.address;
  return {
    proof,
    https: {
      url: `https://${host}:8443/proof`,
      wrongHostnameUrl: `https://${host}:8444/proof`,
      caPEM: certificates.caPEM,
      wrongCAPEM: await readFile(tls.caPath, "utf8"),
      trusted: {
        nonce: trusted.nonce,
        requests: trusted.requests,
        stats: trusted.stats,
      },
      wrongHostname: {
        requests: wrongHostname.requests,
        stats: wrongHostname.stats,
      },
    },
  };
}

/** Ports can move together for parallel test runs; all services remain loopback-only. */
export async function createTailnetConnectFixture({
  peerTLS = false,
  cache = process.env.TAILNET_FIXTURE_CACHE ??
    join(tmpdir(), "opensesame-tailnet-binaries"),
  ports = {
    headscale: 41914,
    stun: 41915,
    control: 41916,
    derp: 41917,
    peer: 41918,
  },
} = {}) {
  const binaries = await fixtureBinaries(cache);
  const directory = await mkdtemp(join(tmpdir(), "opensesame-tailnet-"));
  const cleanups = [() => rm(directory, { recursive: true, force: true })];
  try {
    const config = await writeConfiguration(directory, ports);
    const tls = await fixtureTls(directory);
    const control = [];
    const derp = [];
    cleanups.push(
      await ownedProcess(
        binaries.headscale,
        ["-c", config, "serve"],
        join(directory, "headscale.log"),
        process.env,
      ),
    );
    await waitUntil(
      async () =>
        (
          await fetch(`http://127.0.0.1:${ports.headscale}/health`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok,
      "Headscale health",
    );
    cleanups.push(
      await forwardingEdge({
        port: ports.control,
        upstreamPort: ports.headscale,
        records: control,
      }),
    );
    cleanups.push(
      await forwardingEdge({
        port: ports.derp,
        upstreamPort: ports.headscale,
        records: derp,
        tls,
      }),
    );
    const controlUrl = `http://localhost:${ports.control}`;
    const native = await enrollNative({
      binaries,
      directory,
      config,
      controlUrl,
      tls,
      cleanups,
    });
    const { proof, https } = await peerServices({
      native,
      directory,
      ports,
      tls,
      cleanups,
      peerTLS,
    });
    const result = {
      controlUrl,
      authKey: native.authKey,
      peerUrl: `http://${native.address}:8080/proof`,
      nonce: proof.nonce,
      control,
      derp,
      peer: proof.requests,
      // Whether the native peer's own netmap holds a node at `address` that
      // control reports online: until it does, the peer drops that node's
      // WireGuard handshakes and nothing it sends can reach a service here.
      peerSeesOnline: async (address) => {
        const status = NativePeers.parse(
          JSON.parse(await native.cli(["status", "--json"])),
        );
        return Object.values(status.Peer ?? {}).some(
          (peer) =>
            peer.Online === true && (peer.TailscaleIPs ?? []).includes(address),
        );
      },
      chromiumArgs: [
        "--no-proxy-server",
        `--host-resolver-rules=MAP derp.fixture.test 127.0.0.1:${ports.derp}`,
        `--ignore-certificate-errors-spki-list=${tls.spki}`,
      ],
      close: () => closeAll(cleanups),
    };
    if (https) result.peerTLS = https;
    return result;
  } catch (error) {
    await closeAll(cleanups);
    throw error;
  }
}
