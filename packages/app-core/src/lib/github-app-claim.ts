import {
  type JsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * GitHub App convert + installation listing against the Connect relay.
 */
import { sessionStore } from "../ports.js";
import { readBoundedObject } from "./bounded-response.js";
import {
  type LocalGithubApp,
  forgetLocalGithubApp,
  hasPendingGithubAppSecret,
  ownerFromPayload,
  pemFromVault,
  readInstallations,
  readLocalGithubApp,
  refreshGithubAppOwner,
  rememberLocalGithubApp,
  sealPendingGithubAppPem,
  stashPendingGithubAppSecret,
} from "./github-app-local.js";
import { githubAppRelayBase } from "./github-app-relay.js";

async function applyInstallationsPayload(
  app: LocalGithubApp,
  payload: JsonObject,
): Promise<LocalGithubApp> {
  const installations = readInstallations(payload.installations);
  const ownerLogin = isString(payload.ownerLogin)
    ? payload.ownerLogin
    : app.ownerLogin;
  const ownerType = isString(payload.ownerType)
    ? payload.ownerType
    : app.ownerType;
  const next: LocalGithubApp = {
    ...app,
    ownerLogin,
    ownerType,
    installations,
  };
  rememberLocalGithubApp(next);
  return ownerLogin ? next : ((await refreshGithubAppOwner(next)) ?? next);
}

/** List orgs/users where the App is installed (needs sealed PEM). */
export async function refreshGithubAppInstallations(
  app: LocalGithubApp | null = readLocalGithubApp(),
): Promise<LocalGithubApp | null> {
  if (!app) return null;
  const pem = pemFromVault(app);
  if (!pem) return refreshGithubAppOwner(app);
  const base = githubAppRelayBase();
  if (base === "") return app;
  try {
    const response = await fetch(`${base}/api/github-app/installations`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ appId: app.id, pem }),
    });
    const payload = overlapCast(
      await readBoundedObject(response, 65536, 8000).catch(() => null),
    );
    if (!response.ok) {
      if (response.status === 401 || response.status === 404) {
        if (hasPendingGithubAppSecret(app.id)) {
          return refreshGithubAppOwner(app);
        }
        forgetLocalGithubApp();
        return null;
      }
      return refreshGithubAppOwner(app);
    }
    return applyInstallationsPayload(app, payload);
  } catch {
    return refreshGithubAppOwner(app);
  }
}

export async function claimGithubAppCode(
  code: string,
  state: string,
): Promise<"registered" | "ignored" | "failed"> {
  const expected = sessionStore().getItem("opensesame.github-app.state");
  if (!expected || expected !== state || code.trim() === "") return "ignored";
  sessionStore().removeItem("opensesame.github-app.state");
  try {
    const base = githubAppRelayBase();
    if (base === "") return "failed";
    const response = await fetch(`${base}/api/github-app/convert`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code }),
    });
    const payload = overlapCast(
      await readBoundedObject(response, 65536, 8000).catch(() => null),
    );
    if (!response.ok || !isString(payload.client_id)) return "failed";
    const id = isNumber(payload.id) ? String(payload.id) : payload.client_id;
    const name = isString(payload.name) ? payload.name : "GitHub App";
    const html = isString(payload.html_url) ? payload.html_url : null;
    const { ownerLogin, ownerType } = ownerFromPayload(payload);
    const secret = [payload.client_secret, payload.pem]
      .filter(isString)
      .join("\n");
    const app: LocalGithubApp = {
      id,
      key: "github-oauth",
      displayName: name,
      htmlUrl: html,
      ownerLogin,
      ownerType,
      installedByLogin: null,
      installations: [],
    };
    rememberLocalGithubApp(app);
    // Memory only; sealed now when a durable vault is open, else on unlock.
    stashPendingGithubAppSecret(app, secret);
    await sealPendingGithubAppPem();
    const refreshed = await refreshGithubAppInstallations(app);
    if (refreshed?.ownerLogin) rememberLocalGithubApp(refreshed);
    return "registered";
  } catch {
    return "failed";
  }
}
