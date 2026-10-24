/** Independent RSA/provider discovery used by full native App consumer tests. */
import { verify } from "node:crypto";
import type { JsonValue } from "@opensesame/os-domain";
import { expect } from "vitest";
import { keyPair } from "./github-app-direct.test-support.js";

type Reply = { status: number; value: JsonValue };
export function verifyBackupAppAssertion(authorization: string, appId: string) {
  expect(authorization.startsWith("Bearer ")).toBe(true);
  const jwt = authorization.replace(/^Bearer /, "").split(".");
  expect(JSON.parse(Buffer.from(jwt[0] ?? "", "base64url").toString())).toEqual(
    { alg: "RS256", typ: "JWT" },
  );
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(`${jwt[0]}.${jwt[1]}`),
      keyPair.publicKey,
      Buffer.from(jwt[2] ?? "", "base64url"),
    ),
  ).toBe(true);
  expect(
    JSON.parse(Buffer.from(jwt[1] ?? "", "base64url").toString()).iss,
  ).toBe(appId);
}
export function githubBackupDiscoveryReply(
  path: string,
  method: string,
  authorization: string,
  app: { id: string; displayName: string },
  branch: string,
  denied: boolean,
): Reply | null {
  if (method !== "GET") return null;
  if (path === "/app" || path === "/app/installations?per_page=100&page=1") {
    verifyBackupAppAssertion(authorization, app.id);
    if (denied) return { status: 403, value: {} };
    if (path === "/app") {
      if (!/^\d+$/.test(app.id)) return { status: 400, value: {} };
      return {
        status: 200,
        value: {
          id: Number(app.id),
          slug: "owned-backup-fixture",
          name: app.displayName,
          owner: { login: "fixture-owner", type: "User" },
          html_url: "https://github.com/apps/owned-backup-fixture",
        },
      };
    }
    return {
      status: 200,
      value: [
        {
          id: 77,
          account: { login: "fixture-owner", type: "User" },
          repository_selection: "selected",
        },
      ],
    };
  }
  if (path !== "/installation/repositories?per_page=100&page=1") return null;
  expect(authorization).toBe("Bearer ghs_owned_repository_token");
  return {
    status: 200,
    value: {
      total_count: 1,
      repositories: [
        {
          id: 17,
          name: "backups",
          full_name: "fixture-owner/backups",
          private: true,
          default_branch: branch,
          owner: { login: "fixture-owner" },
        },
      ],
    },
  };
}
