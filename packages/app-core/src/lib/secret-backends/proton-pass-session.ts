import type { BoundaryValue } from "@opensesame/os-domain";
import {
  SecretBackendHttpError,
  createBackendHttp,
  secretBackendUrl,
} from "./http.js";
import { importProtonKey, openProtonValue } from "./proton-pass-crypto.js";
import {
  type ProtonPassConfiguration,
  type ProtonShare,
  protonConfiguration,
  protonKeys,
  protonSessionReply,
  protonShare,
  protonVaultName,
  splitProtonPat,
} from "./proton-pass-protocol.js";
import { createSecretBackendSessions } from "./sessions.js";
import type { SecretBackendTransport } from "./transport.js";
import { SecretBackendError, type SecretBackendSession } from "./types.js";

type Request = (path: string, init?: RequestInit) => Promise<BoundaryValue>;
export type ProtonPassAccess = Readonly<{
  share: ProtonShare;
  vaultName: string;
  latestRotation: number;
  key(rotation: number): CryptoKey;
  request: Request;
  close(): void;
}>;
function ended(): SecretBackendError {
  return new SecretBackendError(
    "stale",
    "The Proton Pass session ended. Connect again.",
  );
}
function lifetime(
  config: Omit<ProtonPassConfiguration, "token">,
  transport: SecretBackendTransport,
) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, transport.signal]);
  const started = Date.now();
  const monotonic = performance.now();
  let duration = 2 * 60 * 60 * 1000;
  let uid = "";
  let token = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const keys = new Map<number, CryptoKey>();
  const close = () => {
    uid = "";
    token = "";
    keys.clear();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    transport.signal.removeEventListener("abort", close);
    controller.abort();
  };
  const assertCurrent = () => {
    if (
      Math.max(Date.now() - started, performance.now() - monotonic) >= duration
    )
      close();
    if (signal.aborted) throw ended();
    try {
      transport.assertCurrent();
    } catch (error) {
      close();
      throw error;
    }
    if (signal.aborted) throw ended();
  };
  const request = createBackendHttp(
    config.baseUrl,
    transport.fetch.bind(transport),
  );
  const call: Request = async (path, init = {}) => {
    assertCurrent();
    const headers = new Headers(init.headers);
    headers.set("x-pm-appversion", config.appVersion);
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
      headers.set("x-pm-uid", uid);
    }
    try {
      const result = await request(path, {
        ...init,
        headers,
        signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
      });
      assertCurrent();
      return result;
    } catch (error) {
      if (error instanceof SecretBackendHttpError && error.status === 401)
        close();
      if (signal.aborted) throw ended();
      throw error;
    }
  };
  transport.signal.addEventListener("abort", close, { once: true });
  if (transport.signal.aborted) close();
  return {
    signal,
    assertCurrent,
    close,
    call,
    keys,
    install(reply: BoundaryValue) {
      const session = protonSessionReply(reply, started);
      uid = session.uid;
      token = session.token;
      duration = session.deadline - started;
      const arm = () => {
        try {
          assertCurrent();
          timer = setTimeout(
            arm,
            Math.max(
              1,
              duration -
                Math.max(Date.now() - started, performance.now() - monotonic),
            ),
          );
        } catch {
          close();
        }
      };
      arm();
    },
  };
}
type Lifetime = ReturnType<typeof lifetime>;
async function shareKeys(
  held: Lifetime,
  share: ProtonShare,
  pat: CryptoKey,
): Promise<void> {
  let total = 256;
  let count = 0;
  for (let page = 0; count < total && page < 3; page += 1) {
    const reply = protonKeys(
      await held.call(
        `pass/v1/share/${encodeURIComponent(share.id)}/key?Page=${page}&PageSize=100`,
      ),
    );
    if (
      (page > 0 && total !== reply.Total) ||
      reply.Keys.length === 0 ||
      count + reply.Keys.length > reply.Total
    )
      throw new SecretBackendError(
        "response",
        "Proton Pass returned incomplete share keys.",
      );
    total = reply.Total;
    for (const entry of reply.Keys) {
      held.assertCurrent();
      if (held.keys.has(entry.KeyRotation))
        throw new SecretBackendError(
          "response",
          "Proton Pass returned repeated key rotations.",
        );
      const raw = await openProtonValue(entry.Key, pat, "sharekey", held);
      try {
        held.keys.set(entry.KeyRotation, await importProtonKey(raw, held));
      } finally {
        raw.fill(0);
      }
      count += 1;
    }
  }
  if (count !== total || !held.keys.has(share.rotation))
    throw new SecretBackendError(
      "response",
      "Proton Pass did not return the selected vault key rotation.",
    );
}
function access(
  held: Lifetime,
  share: ProtonShare,
  vaultName: string,
  baseUrl: string,
  checkSession: () => void,
): ProtonPassAccess {
  const base = secretBackendUrl(baseUrl);
  const prefix = new URL(
    `pass/v1/share/${encodeURIComponent(share.id)}/`,
    base,
  );
  return {
    share,
    vaultName,
    latestRotation: Math.max(...held.keys.keys()),
    close: held.close,
    key(rotation) {
      checkSession();
      held.assertCurrent();
      const key = held.keys.get(rotation);
      if (!key)
        throw new SecretBackendError(
          "response",
          "The requested Proton Pass key rotation is missing.",
        );
      return key;
    },
    async request(path, init = {}) {
      checkSession();
      held.assertCurrent();
      const target = new URL(path.replace(/^\//, ""), prefix);
      if (
        target.origin !== prefix.origin ||
        !target.pathname.startsWith(prefix.pathname) ||
        target.hash
      )
        throw new SecretBackendError(
          "configuration",
          "The operation must stay within this PAT-scoped share.",
        );
      if (
        !share.writable &&
        !["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase())
      )
        throw new SecretBackendError(
          "authentication",
          "This PAT grants read access. Use an editor grant to write backups or items.",
        );
      return held.call(
        target.pathname.slice(base.pathname.length) + target.search,
        init,
      );
    },
  };
}
export function createProtonPassSessions(transport: SecretBackendTransport) {
  const sessions = createSecretBackendSessions<ProtonPassAccess>("proton-pass");
  return {
    async authenticate(
      config: ProtonPassConfiguration,
    ): Promise<SecretBackendSession> {
      transport.assertCurrent();
      const target = Object.freeze({
        baseUrl: config.baseUrl,
        vaultId: config.vaultId,
        appVersion: config.appVersion,
      });
      protonConfiguration(target);
      secretBackendUrl(target.baseUrl);
      const parsed = splitProtonPat(config.token);
      const held = lifetime(target, transport);
      try {
        const pat = await importProtonKey(parsed.raw, held);
        parsed.raw.fill(0);
        held.install(
          await held.call("account/v4/personal-access-token/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ Token: parsed.token }),
          }),
        );
        const share = protonShare(
          await held.call("pass/v1/share"),
          target.vaultId,
        );
        await shareKeys(held, share, pat);
        const key = held.keys.get(share.rotation);
        if (!key)
          throw new SecretBackendError(
            "response",
            "The selected Proton Pass key rotation is missing.",
          );
        const plain = await openProtonValue(
          share.content,
          key,
          "vaultcontent",
          held,
        );
        let vaultName: string;
        try {
          vaultName = protonVaultName(plain);
        } finally {
          plain.fill(0);
        }
        held.assertCurrent();
        let admitted: SecretBackendSession | null = null;
        const checkSession = () => {
          if (!admitted || admitted.signal?.aborted) throw ended();
          sessions.read(admitted);
        };
        admitted = sessions.create(
          access(held, share, vaultName, target.baseUrl, checkSession),
          held.signal,
        );
        return admitted;
      } catch (error) {
        held.close();
        throw error;
      } finally {
        parsed.raw.fill(0);
      }
    },
    read: sessions.read,
    async disconnect(session: SecretBackendSession): Promise<void> {
      if (session.signal?.aborted) return;
      const held = sessions.read(session);
      sessions.remove(session);
      held.close();
    },
  };
}
