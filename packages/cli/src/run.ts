import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type JsonValue,
  configuredEndpoint,
  isJsonObject,
  isString,
  overlapCast,
  readJsonObject,
  readString,
} from "@opensesame/os-domain";
import {
  DeviceFlowClient,
  createControlPlaneClient,
  loopbackLogin,
  redactSecrets,
} from "@opensesame/sdk-cli";
import { runHostCommand } from "./host-commands.js";
import {
  clearSession,
  loadSession,
  saveSession,
  sessionFor,
} from "./identity-session.js";
import { emit, errorLine } from "./output.js";
import { type ParityDependencies, runParity } from "./parity.js";
import {
  type ParsedCommand,
  SessionFileSchema,
  helpText,
  parseArgs,
} from "./parse.js";
import type { PasswordResetDependencies } from "./password-reset-command.js";
import { dispatchPasswordReset } from "./password-reset-dispatch.js";
import type { SessionDependencies } from "./session-commands.js";
import { type CanaryCliDependencies, runVaultCanary } from "./vault-canary.js";
import { type VaultDependencies, runVaultCommand } from "./vault-commands.js";
import { type VaultItemDependencies, runVaultItems } from "./vault-items.js";
import {
  type RetiredCliDependencies,
  runVaultRetired,
} from "./vault-retired.js";
import { type VaultSyncDependencies, runVaultSync } from "./vault-sync.js";
function defaultIssuer(): string {
  return process.env.OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";
}
type StoredSession = NonNullable<Awaited<ReturnType<typeof loadSession>>>;
/**
 * Revoke an OIDC session at its issuer (RFC 7009). The provisional endpoint
 * only ends guest sessions; a loopback/device login holds a refresh token that
 * stays valid until the issuer revokes it. Returns false when no endpoint is
 * published or the issuer refuses, so `logout` can say the session may remain.
 */
async function revokeIssuerSession(
  session: StoredSession,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  if (!session.refreshToken && !session.accessToken) return true;
  const issuer = session.issuer.replace(/\/+$/u, "");
  try {
    const discovery = await fetchImpl(
      `${issuer}/.well-known/openid-configuration`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!discovery.ok) return false;
    const meta = overlapCast(await discovery.json());
    if (!isJsonObject(meta) || !isString(meta.revocation_endpoint))
      return false;
    if (new URL(meta.revocation_endpoint).origin !== new URL(issuer).origin)
      return false;
    const token = session.refreshToken ?? session.accessToken;
    const response = await fetchImpl(meta.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(5_000),
      body: new URLSearchParams({
        token,
        token_type_hint: session.refreshToken
          ? "refresh_token"
          : "access_token",
        client_id: session.clientId,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

interface RunDependencies
  extends CanaryCliDependencies,
    RetiredCliDependencies,
    VaultDependencies,
    VaultItemDependencies,
    VaultSyncDependencies,
    ParityDependencies,
    PasswordResetDependencies,
    SessionDependencies {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => void;
}
interface DispatchContext {
  issuer: string;
  api: string;
  clientId: string;
  fetchImpl: typeof fetch;
  deps: RunDependencies | undefined;
}
/** The public half of a stored agent identity, refused unless both halves are an EC P-256 pair. */
function storedAgentPublicKey(text: string): JsonWebKey {
  const raw: JsonValue = JSON.parse(text);
  const file = readJsonObject(raw);
  const privateJwk = readJsonObject(file?.privateJwk);
  const publicJwk = readJsonObject(file?.publicJwk);
  const x = readString(publicJwk?.x);
  const y = readString(publicJwk?.y);
  if (
    privateJwk?.d === undefined ||
    publicJwk?.kty !== "EC" ||
    publicJwk.crv !== "P-256" ||
    !x ||
    !y
  )
    throw new Error("Agent identity file is invalid.");
  return { crv: "P-256", kty: "EC", x, y };
}

/**
 * The agent's public-key thumbprint is an identity, not a random label. Keep
 * the private half in the CLI state directory so the same agent can prove
 * possession when a person claims it, and reuse it across `agent init` runs.
 */
async function agentPublicKeyThumbprint(): Promise<string> {
  const base =
    process.env.OPENSESAME_STATE_DIR ??
    process.env.XDG_RUNTIME_DIR ??
    join(homedir(), ".config", "opensesame");
  const path = join(base, "agent-identity.json");
  const thumbprint = (jwk: JsonWebKey): string =>
    createHash("sha256")
      .update(
        JSON.stringify({
          crv: jwk.crv,
          kty: jwk.kty,
          x: jwk.x,
          y: jwk.y,
        }),
      )
      .digest("base64url");

  try {
    return thumbprint(storedAgentPublicKey(await readFile(path, "utf8")));
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }

  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const [publicJwk, privateJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ]);
  await mkdir(base, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, JSON.stringify({ v: 1, publicJwk, privateJwk }), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return agentPublicKeyThumbprint();
    }
    throw error;
  }
  return thumbprint(publicJwk);
}

export async function runCli(
  argv: string[],
  deps?: RunDependencies,
): Promise<number> {
  let command: ParsedCommand;
  try {
    command = parseArgs(argv);
  } catch (err) {
    process.stderr.write(errorLine(overlapCast(err)));
    return 1;
  }

  if (command.name === "help") {
    process.stdout.write(helpText());
    return 0;
  }

  const issuer = command.flags.issuer ?? defaultIssuer();
  const api =
    command.flags.api ?? configuredEndpoint("identity", process.env) ?? issuer;
  const clientId = command.flags.clientId ?? "opensesame-cli";
  const fetchImpl = deps?.fetchImpl ?? fetch;

  try {
    return await dispatch(command, { issuer, api, clientId, fetchImpl, deps });
  } catch (err) {
    // A refused endpoint or a failed exchange is a message, not a stack trace.
    process.stderr.write(errorLine(overlapCast(err)));
    return 1;
  }
}

async function dispatch(
  command: Exclude<ParsedCommand, { name: "help" }>,
  ctx: DispatchContext,
): Promise<number> {
  const { issuer, api, clientId, fetchImpl, deps } = ctx;

  switch (command.name) {
    case "canary-serve": {
      const { runAgentCanaryService } = await import(
        "./agent-canary-service.js"
      );
      const service = await runAgentCanaryService(
        command.pairingFile,
        command.stateDirectory,
      );
      await new Promise<void>((resolve) => {
        const finish = () => {
          process.off("SIGINT", finish);
          process.off("SIGTERM", finish);
          resolve();
        };
        process.once("SIGINT", finish);
        process.once("SIGTERM", finish);
      });
      await service.close();
      return 0;
    }
    case "parity":
      return runParity(command, deps);
    case "password-reset":
      return dispatchPasswordReset(command, deps);
    case "login": {
      if (command.mode === "anonymous") {
        // Guest on-ramp: a provisional principal with no upstream identity.
        // Claiming later (identity link) keeps the same principal id, so
        // anything created as a guest survives the upgrade.
        const cp = createControlPlaneClient({ baseUrl: api, fetchImpl });
        const session = await cp.createProvisionalSession();
        const expiresAt = Date.parse(session.expiresAt);
        await saveSession({
          accessToken: session.accessToken,
          ...(Number.isNaN(expiresAt) ? undefined : { expiresAt }),
          issuer,
          clientId,
          anonymous: true,
          principalId: session.principalId,
        });
        emit(
          command.flags,
          `Signed in as guest (${session.principalId}). This session is provisional — link an identity later to keep it; the principal id will not change.`,
          {
            ok: true,
            mode: "anonymous",
            principalId: session.principalId,
            state: session.state,
            assurance: session.assurance,
            expiresAt: session.expiresAt,
          },
        );
        return 0;
      }

      if (command.mode === "loopback") {
        const tokens = await loopbackLogin({
          issuer,
          clientId,
          fetchImpl,
          ...(deps?.openBrowser
            ? { openBrowser: deps.openBrowser }
            : undefined),
        });
        await saveSession({
          accessToken: tokens.access_token,
          ...(tokens.refresh_token !== undefined
            ? { refreshToken: tokens.refresh_token }
            : undefined),
          ...(tokens.id_token !== undefined
            ? { idToken: tokens.id_token }
            : undefined),
          ...(tokens.expires_in !== undefined
            ? { expiresAt: Date.now() + tokens.expires_in * 1000 }
            : undefined),
          issuer,
          clientId,
        });
        emit(command.flags, "Logged in via loopback.", {
          ok: true,
          mode: "loopback",
        });
        return 0;
      }

      // device (explicit or auto default for headless-safe CLI)
      const device = new DeviceFlowClient({
        issuer,
        clientId,
        fetchImpl,
        ...(deps?.sleep ? { sleep: deps.sleep } : undefined),
      });
      const start = await device.start();
      if (!command.flags.json) {
        const wantQr =
          command.qrPreference === "on" ||
          (command.qrPreference === "auto" && Boolean(process.stdout.isTTY));
        process.stdout.write(
          `${device.formatInstructions(start, { qr: wantQr })}\n\n`,
        );
      } else {
        emit(command.flags, "", {
          ok: true,
          mode: "device",
          userCode: start.userCode,
          verificationUri: start.verificationUri,
          verificationUriComplete: start.verificationUriComplete,
          expiresIn: start.expiresIn,
        });
      }
      const tokens = await device.pollUntilComplete();
      await saveSession({
        accessToken: tokens.access_token,
        ...(tokens.refresh_token !== undefined
          ? { refreshToken: tokens.refresh_token }
          : undefined),
        ...(tokens.id_token !== undefined
          ? { idToken: tokens.id_token }
          : undefined),
        ...(tokens.expires_in !== undefined
          ? { expiresAt: Date.now() + tokens.expires_in * 1000 }
          : undefined),
        issuer,
        clientId,
      });
      if (!command.flags.json) {
        process.stdout.write("Logged in via device authorization.\n");
      } else {
        emit(command.flags, "", { ok: true, authenticated: true });
      }
      return 0;
    }

    case "auth-status": {
      const session = await sessionFor(await loadSession(), issuer, fetchImpl);
      const cp = createControlPlaneClient({
        baseUrl: api,
        ...(session ? { accessToken: session.accessToken } : undefined),
        fetchImpl,
      });
      const status = await cp.authStatus();
      emit(
        command.flags,
        status.authenticated ? "Authenticated." : "Not authenticated.",
        status,
      );
      return 0;
    }

    case "logout": {
      // Revoke the credential that is actually on disk. A refresh is not
      // needed to log out, and a failed/expired refresh must not silently
      // skip revocation and leave a live server session behind.
      const stored = await loadSession();
      const session =
        stored &&
        stored.issuer.replace(/\/+$/u, "") === issuer.replace(/\/+$/u, "")
          ? stored
          : null;
      if (session) {
        const cp = createControlPlaneClient({
          baseUrl: api,
          accessToken: session.accessToken,
          fetchImpl,
        });
        try {
          await cp.logout();
        } catch {
          // local clear still happens
        }
        const revocationConfirmed =
          session.anonymous === true ||
          (await revokeIssuerSession(session, fetchImpl));
        await clearSession();
        emit(
          command.flags,
          revocationConfirmed
            ? "Signed out."
            : "Signed out. The issuer did not confirm remote revocation.",
          { ok: true, revocationConfirmed },
        );
        return 0;
      }
      await clearSession();
      emit(command.flags, "Signed out.", { ok: true });
      return 0;
    }
    case "whoami": {
      const session = await sessionFor(await loadSession(), issuer, fetchImpl);
      if (!session) {
        emit(command.flags, "Not authenticated.", { authenticated: false });
        return 1;
      }
      const cp = createControlPlaneClient({
        baseUrl: api,
        accessToken: session.accessToken,
        fetchImpl,
      });
      const me = await cp.whoami();
      emit(command.flags, JSON.stringify(me, null, 2), me);
      return 0;
    }

    case "project-create": {
      const session = await sessionFor(await loadSession(), issuer, fetchImpl);
      if (!session) {
        process.stderr.write("Login required.\n");
        return 1;
      }
      if (!command.temporary) {
        process.stderr.write(
          "Only --temporary projects are supported in this slice.\n",
        );
        return 1;
      }
      const cp = createControlPlaneClient({
        baseUrl: api,
        accessToken: session.accessToken,
        fetchImpl,
      });
      const project = await cp.createTemporaryProject({
        name: command.projectName,
      });
      emit(command.flags, "Temporary project created.", redactSecrets(project));
      return 0;
    }

    case "claim-poll": {
      const session = await sessionFor(await loadSession(), issuer, fetchImpl);
      const cp = createControlPlaneClient({
        baseUrl: api,
        ...(session ? { accessToken: session.accessToken } : undefined),
        fetchImpl,
      });
      const claim = await cp.pollClaim(command.claimId, command.claimToken);
      emit(command.flags, JSON.stringify(claim, null, 2), redactSecrets(claim));
      return 0;
    }

    case "agent-init": {
      if (!command.anonymous) {
        process.stderr.write(
          "Use --anonymous for provisional agent registration.\n",
        );
        return 1;
      }
      const cp = createControlPlaneClient({ baseUrl: api, fetchImpl });
      const agent = await cp.registerAnonymousAgent({
        displayName: command.displayName,
        publicKeyJkt: await agentPublicKeyThumbprint(),
      });
      emit(
        command.flags,
        "Anonymous agent registered. Complete claim in the console.",
        redactSecrets(agent),
      );
      return 0;
    }

    case "host-health":
    case "host-discover":
      return runHostCommand(command, fetchImpl);

    case "vault-verify":
    case "vault-ls":
      return runVaultCommand(command, deps);

    case "vault-list":
    case "vault-new":
    case "vault-import":
    case "vault-export":
    case "vault-set":
    case "vault-copy":
    case "vault-share":
      return runVaultItems(command, deps);

    case "vault-canary":
      return runVaultCanary(command, deps);
    case "vault-retired":
      return runVaultRetired(command, deps);
    case "vault-sync":
      return runVaultSync(command, deps);

    case "session": {
      // Loaded on demand: no other command pays for the relay client.
      const { runSession } = await import("./session-commands.js");
      return runSession(command, deps);
    }

    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      return 1;
    }
  }
}

export { parseArgs, helpText, SessionFileSchema };
