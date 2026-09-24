import type { ServiceAssertionKey } from "@opensesame/agent-protocols";
import { exportJWK, generateKeyPair, importJWK } from "jose";
import type { JWK } from "jose";

export interface AgentAuthRuntime {
  key: ServiceAssertionKey;
  publicKey: ServiceAssertionKey["privateKey"];
}

let runtimePromise: Promise<AgentAuthRuntime> | undefined;

export async function agentAuthRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentAuthRuntime> {
  runtimePromise ??= loadAgentAuthRuntime(env);
  return runtimePromise;
}

export function resetAgentAuthRuntimeForTests(): void {
  runtimePromise = undefined;
}

async function loadAgentAuthRuntime(
  env: NodeJS.ProcessEnv,
): Promise<AgentAuthRuntime> {
  const fromEnv = await runtimeFromJwksEnv(env);
  if (fromEnv) return fromEnv;
  const isProduction =
    env.NODE_ENV === "production" || env.OPENSESAME_ENV === "production";
  if (isProduction) {
    throw new Error(
      "AgentAuth service assertion signing keys are required in production — set OPENSESAME_JWKS_JSON or OPENSESAME_AGENT_AUTH_SIA_JWK",
    );
  }
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "os-sia-1";
  publicJwk.alg = "ES256";
  publicJwk.use = "sig";
  return {
    publicKey,
    key: {
      privateKey,
      publicJwk,
      kid: "os-sia-1",
      alg: "ES256",
    },
  };
}

async function runtimeFromJwksEnv(
  env: NodeJS.ProcessEnv,
): Promise<AgentAuthRuntime | undefined> {
  const single = env.OPENSESAME_AGENT_AUTH_SIA_JWK;
  const set = env.OPENSESAME_JWKS_JSON;
  const raw = single ?? set;
  if (!raw) return undefined;
  let keys: JWK[] = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (single) {
      // SAFETY: test/fixture or boundary-checked value matches JWK].
      keys = [parsed as JWK];
    } else {
      // SAFETY: test/fixture or boundary-checked value matches { keys?: JWK[] }.
      const obj = parsed as { keys?: JWK[] };
      keys = Array.isArray(obj.keys) ? obj.keys : [];
    }
  } catch {
    throw new Error("AgentAuth signing JWKS is not valid JSON");
  }
  const chosen =
    keys.find((key) => key.kid === "os-sia-1" && key.d) ??
    keys.find((key) => (key.alg === "ES256" || key.alg === "RS256") && key.d);
  if (!chosen || !chosen.d) return undefined;
  const alg = chosen.alg === "RS256" ? "RS256" : "ES256";
  const privateKey = await importJWK(chosen, alg);
  const {
    d: _d,
    p: _p,
    q: _q,
    dp: _dp,
    dq: _dq,
    qi: _qi,
    ...publicJwk
  } = chosen;
  publicJwk.kid = chosen.kid ?? "os-sia-1";
  publicJwk.alg = alg;
  publicJwk.use = "sig";
  return {
    publicKey: privateKey,
    key: {
      privateKey,
      publicJwk,
      kid: String(publicJwk.kid),
      alg,
    },
  };
}
