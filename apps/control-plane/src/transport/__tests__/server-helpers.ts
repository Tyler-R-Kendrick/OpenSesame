import { onFreePort } from "../../__tests__/free-port.js";
import type { StartedControlPlane } from "../../server.js";
/** Boot a real control-plane with the optional TLS listener for transport tests. */
import type { TransportConfig, TransportListenerConfig } from "../config.js";
import type { DisposablePki, Issued } from "./pki.js";

export interface BootOptions {
  pki: DisposablePki;
  server: Issued;
  policy: TransportListenerConfig["policy"];
  mappingAuth?: TransportConfig["mappingAuth"];
  serviceBindingsFile?: string;
  ingressOriginatingTrustFile?: string;
}

export async function bootWithTls(
  options: BootOptions,
): Promise<StartedControlPlane & { tlsPort: number }> {
  const { startServer } = await import("../../server.js");
  const listener: TransportListenerConfig = {
    host: "127.0.0.1",
    port: 0,
    policy: options.policy,
    certFile: options.server.certPath,
    keyFile: options.server.keyPath,
    clientCaFile: options.pki.caCertPath,
    minVersion: "tls13",
    trustProfile: "client_ca",
    ...(options.serviceBindingsFile
      ? { serviceBindingsFile: options.serviceBindingsFile }
      : undefined),
    ...(options.ingressOriginatingTrustFile
      ? { ingressOriginatingTrustFile: options.ingressOriginatingTrustFile }
      : undefined),
  };
  const started = await onFreePort((port) =>
    startServer({
      config: {
        host: "127.0.0.1",
        port,
        publicUrl: `http://127.0.0.1:${port}`,
        issuer: `http://127.0.0.1:${port}`,
        transport: {
          listener,
          mappingAuth: options.mappingAuth ?? "shared_secret",
          mappingAuthExplicit: true,
        },
      },
    }),
  );
  const tlsPort = started.transport?.port;
  if (tlsPort === undefined) throw new Error("TLS listener did not start");
  return { ...started, tlsPort };
}

export async function shutdown(started: StartedControlPlane): Promise<void> {
  await started.transport?.close();
  await new Promise<void>((resolve) => started.server.close(() => resolve()));
}

/** The mapping binding for a Host presenting `dns`. */
export function mappingBindings(dns: string, extra: object[] = []): object {
  return {
    revision: 1,
    bindings: [
      {
        id: "host-mapping",
        revision: 1,
        enabled: true,
        revoked: false,
        scope: "deployment",
        trust_profile: { name: "client_ca" },
        peer: { dns_name: dns },
        service_principal: "svc_host",
        purpose: "identity_mapping_client",
        allowed_operations: ["principals.mapping.resolve"],
        allowed_audiences: [],
        not_after: null,
        denied_thumbprints: [],
      },
      ...extra,
    ],
  };
}
