import { overlapCast } from "@opensesame/os-domain";
import { expect } from "vitest";
import { startServer } from "../server.js";
import { onFreePort } from "./free-port.js";

export class EnterpriseCookieJar {
  private cookies = new Map<string, string>();
  absorb(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0] ?? "";
      const split = pair.indexOf("=");
      if (split > 0)
        this.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
  }
  header() {
    return {
      cookie: [...this.cookies]
        .map(([key, value]) => `${key}=${value}`)
        .join("; "),
    };
  }
}

export async function enterpriseServer(upstreamIssuer?: string) {
  const processEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
  };
  if (upstreamIssuer) processEnv.OPENSESAME_TRUSTED_UPSTREAMS = upstreamIssuer;
  return onFreePort((port) =>
    startServer({
      config: {
        host: "127.0.0.1",
        port,
        publicUrl: `http://127.0.0.1:${port}`,
        issuer: `http://127.0.0.1:${port}`,
      },
      processEnv,
    }),
  );
}

export type EnterpriseServer = Awaited<ReturnType<typeof enterpriseServer>>;

export async function closeEnterpriseServer(started: EnterpriseServer) {
  await new Promise<void>((resolve, reject) =>
    started.server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function enterpriseOwner(
  started: EnterpriseServer,
  id: string,
  slug: string,
) {
  const created = await started.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  const session: { principalId: string; accessToken: string } =
    await created.json();
  const now = started.ctx.clock();
  await started.ctx.stores.organizations.set(id, {
    id,
    slug,
    displayName: slug,
    state: "active",
    createdBy: session.principalId,
    createdAt: now,
    updatedAt: now,
  });
  await started.ctx.stores.organizationMemberships.upsert({
    organizationId: id,
    principalId: session.principalId,
    role: "owner",
    createdAt: now,
    updatedAt: now,
  });
  return {
    authorization: `Bearer ${session.accessToken}`,
    "content-type": "application/json",
  };
}

export async function enterpriseRequest(
  base: string,
  jar: EnterpriseCookieJar,
  path: string,
  init: RequestInit = {},
) {
  const response = await fetch(
    path.startsWith("http") ? path : `${base}${path}`,
    {
      redirect: "manual",
      ...init,
      headers: { ...jar.header(), ...overlapCast(init.headers) },
    },
  );
  jar.absorb(response);
  return response;
}

export function hiddenField(html: string, name: string): string {
  for (const input of html.matchAll(/<input[^>]*>/g)) {
    if (input[0].match(/name="([^"]+)"/)?.[1] === name)
      return input[0].match(/value="([^"]*)"/)?.[1] ?? "";
  }
  throw new Error(`Missing ${name} field`);
}

export async function enterpriseLogin(base: string, slug: string) {
  const jar = new EnterpriseCookieJar();
  const response = await enterpriseRequest(
    base,
    jar,
    `/auth?${new URLSearchParams({
      client_id: "origin:http://127.0.0.1:4331",
      redirect_uri: "http://127.0.0.1:4331/opensesame/callback",
      response_type: "code",
      scope: "openid",
      state: "enterprise-signin",
      nonce: "enterprise-nonce",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      login_hint_provider: `org:${slug}`,
    })}`,
  );
  expect(response.status).toBe(303);
  const location = response.headers.get("location") ?? "";
  const page = await enterpriseRequest(base, jar, location);
  return {
    jar,
    uid: location.slice("/interaction/".length),
    html: await page.text(),
  };
}
