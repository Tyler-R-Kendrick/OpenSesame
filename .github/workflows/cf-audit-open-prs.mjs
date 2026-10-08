import { execFileSync } from "node:child_process";

const repo = process.env.GH_REPO ?? "Tyler-R-Kendrick/OpenSesame";

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function existing(head) {
  const rows = JSON.parse(
    gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      head,
      "--state",
      "open",
      "--json",
      "number,baseRefName,isDraft",
    ]),
  );
  return rows[0] ?? null;
}

function create(base, head, title, body) {
  const found = existing(head);
  if (found) {
    if (found.baseRefName !== base) {
      gh([
        "pr",
        "edit",
        String(found.number),
        "--repo",
        repo,
        "--base",
        base,
      ]);
      console.error(
        `REBASED #${found.number} ${head} ${found.baseRefName} -> ${base}`,
      );
    } else {
      console.error(`ALREADY #${found.number} ${head} base ${base}`);
    }
    if (!found.isDraft) {
      gh(["pr", "ready", String(found.number), "--repo", repo, "--undo"]);
      console.error(`DRAFT #${found.number}`);
    }
    return found.number;
  }
  const url = gh([
    "pr",
    "create",
    "--repo",
    repo,
    "--draft",
    "--base",
    base,
    "--head",
    head,
    "--title",
    title,
    "--body",
    body,
  ]);
  console.error(`OPENED ${url}`);
  const number = Number(url.split("/").pop());
  if (!Number.isInteger(number)) {
    throw new Error(`No pull request number in ${url}`);
  }
  return number;
}

function body(finding, stack, base) {
  return [
    `Cloudflare audit run 1, finding ${finding}`,
    "",
    `Stack: ${stack}/8, base ${base}`,
    "",
    "Credit: Grok Build",
    "",
  ].join("\n");
}

const art = create(
  "main",
  "cursor/cf-audit-run-1-artifacts",
  "Record Cloudflare security audit run 1",
  [
    "Cloudflare audit run 1 record. Docs only: the run report, findings, and needs-validation notes. No product code.",
    "",
    "The eight fixes are a separate stack based on main.",
    "",
    "Credit: Grok Build",
    "",
  ].join("\n"),
);

const token = create(
  "main",
  "cursor/cf-audit-token-endpoint",
  "Reject a storage-chosen federation token endpoint",
  body(
    "app-core.federation.storage-selected-token-endpoint",
    1,
    "main",
  ),
);

const ld = create(
  "cursor/cf-audit-token-endpoint",
  "cursor/cf-audit-ld-audit",
  "Reserve LD_AUDIT on the startup-hook denylist",
  body("packages/cli/startup-env-denylist-omits-ld-audit", 2, `#${token}`),
);

const email = create(
  "cursor/cf-audit-ld-audit",
  "cursor/cf-audit-email-retarget",
  "Refuse a caller membership when verified email retargets the join",
  body("control-plane.org-join.email-retarget-membership", 3, `#${ld}`),
);

const scim = create(
  "cursor/cf-audit-email-retarget",
  "cursor/cf-audit-scim-issuer",
  "Deprovision SCIM members under the directory issuer",
  body(
    "control-plane.scim.principalsForSubject.omits-directory-issuer",
    4,
    `#${email}`,
  ),
);

const ipv4 = create(
  "cursor/cf-audit-scim-issuer",
  "cursor/cf-audit-ipv4-mapped",
  "Reject private IPv4-mapped OpenID4VP request URIs",
  body(
    "crates/authenticator-core/host_is_private/ipv4-mapped-request-uri",
    5,
    `#${scim}`,
  ),
);

const limit = create(
  "cursor/cf-audit-ipv4-mapped",
  "cursor/cf-audit-body-limit",
  "Reject an oversized relay body with 413",
  body(
    "apps/pages/server/manage.mjs/readRawBody/unbounded-buffer",
    6,
    `#${ipv4}`,
  ),
);

const slash = create(
  "cursor/cf-audit-body-limit",
  "cursor/cf-audit-backslash",
  "Reject raw-backslash local-session proxy paths",
  body("daemon.proxy.backslash-canonicalizes-local-session", 7, `#${limit}`),
);

const getrun = create(
  "cursor/cf-audit-backslash",
  "cursor/cf-audit-getrun",
  "Require the opened run when getRun changes origin",
  body("runner.drive.getRun-origin-unbound", 8, `#${slash}`),
);

console.log(
  JSON.stringify({
    art,
    token,
    ld,
    email,
    scim,
    ipv4,
    limit,
    slash,
    getrun,
  }),
);
