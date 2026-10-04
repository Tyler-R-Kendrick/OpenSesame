/**
 * What the example Node relying party refuses at startup and under load
 * (ADR 0161): discovery that does not check out, a plaintext address nobody
 * opted into, a client over its allowance, a store with no room. Each runs a
 * real second process. Split from `siop-rp-journey.mjs` for the module budget.
 */
import { expect } from "@playwright/test";
import { freePort, startRelyingParty } from "./siop-rp-server.mjs";
import { post, startLoginElsewhere } from "./siop-rp-steps.mjs";

const pass = (what) => console.log(`PASS ${what}`);

/**
 * Discovery is read at startup, pinned to the issuer the operator configured,
 * and a document that does not check out stops the process. So does a setting
 * that would let a plaintext address through.
 */
export async function discoveryRefusals(env, rpEnv) {
  const stops = async (what, extra) => {
    const rp = startRelyingParty(rpEnv(extra));
    // A relying party that was meant to refuse and instead listens is a
    // failure, not a wait: bound it, say which, and stop it.
    const exited = await Promise.race([
      rp.exited,
      new Promise((resolve) =>
        setTimeout(() => resolve("still running"), 15_000),
      ),
    ]);
    if (exited === "still running") await rp.stop();
    expect(exited, `${what}: the relying party must refuse to start`).not.toBe(
      "still running",
    );
    expect(exited, what).not.toBe(0);
    return rp.output();
  };
  await stops("not json", {
    SIOP_RP_METADATA_URL: `${env.metadataServer}/index.html`,
  });
  await stops("another issuer", {
    OPENSESAME_PAGES_BASE: "https://evil.example/OpenSesame",
  });
  // Not the issuer's own origin, and the operator did not say it is a mirror.
  await stops("document from another origin", {
    SIOP_RP_METADATA_MIRROR: "",
  });
  // A loopback redirect over http is local development, and says so.
  await stops("plaintext loopback without the opt-in", {
    SIOP_RP_ALLOW_LOOPBACK_HTTP: "",
    SIOP_RP_DISCOVER: "",
  });
  pass(
    "rp startup: a page that is not the metadata, metadata for another issuer, a document from an origin the operator did not name, and loopback http without the opt-in each stop the relying party",
  );
}

/**
 * A second, real process with small limits: one client may not start more
 * logins than its allowance, and a store with no room refuses (503) rather
 * than push out a login somebody is in the middle of.
 */
export async function floods(env, rpEnv) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const listen = {
    SIOP_RP_LISTEN: `127.0.0.1:${port}`,
    SIOP_RP_REDIRECT_URI: `${url}/callback`,
    SIOP_RP_DISCOVER: "",
  };
  const limited = startRelyingParty(
    rpEnv({ ...listen, SIOP_RP_STARTS_PER_MINUTE: "2" }),
  );
  await limited.ready;
  try {
    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push(
        (
          await fetch(`${url}/auth/start`, {
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
          })
        ).status,
      );
    }
    expect(statuses).toEqual([302, 302, 429]);
  } finally {
    await limited.stop();
  }
  const full = startRelyingParty(
    rpEnv({ ...listen, SIOP_RP_MAX_PENDING_LOGINS: "2" }),
  );
  await full.ready;
  try {
    const first = await startLoginElsewhere(url);
    const second = await startLoginElsewhere(url);
    const refused = await fetch(`${url}/auth/start`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("30");
    // Neither login in progress was pushed out to make room.
    for (const login of [first, second]) {
      const denied = `#${new URLSearchParams({ error: "access_denied", state: login.state })}`;
      expect((await post(url, "/callback", denied, login.cookie)).body).toEqual(
        { error: "provider_error" },
      );
    }
  } finally {
    await full.stop();
  }
  pass(
    "rp flood: a client over its allowance gets 429, and a full login store answers 503 without evicting a login in progress",
  );
}
