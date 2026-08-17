import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createApiClient } from "@opensesame/api-client";
import {
  DeviceFlowClient,
  createControlPlaneClient,
  loopbackLogin,
  redactSecrets,
} from "@opensesame/sdk-cli";
import {
  type ParsedCommand,
  type SessionFile,
  SessionFileSchema,
  helpText,
  parseArgs,
} from "./parse.js";

function defaultIssuer(): string {
  return process.env.OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";
}

function defaultApi(issuer: string): string {
  return process.env.OPENSESAME_API_URL ?? issuer;
}

function sessionPath(): string {
  // An explicit setting outranks the ambient one: OPENSESAME_STATE_DIR is a choice,
  // XDG_RUNTIME_DIR is whatever the session manager happened to export.
  const base =
    process.env.OPENSESAME_STATE_DIR ??
    process.env.XDG_RUNTIME_DIR ??
    join(homedir(), ".config", "opensesame");
  return join(base, "identity-session.json");
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

/**
 * Refuse a session file anyone but its owner can read or write. A bearer token in
 * a group-readable file is a bearer token every account on the box holds, and one
 * in a writable file is a token another account gets to choose.
 */
async function assertPrivateFile(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(
      `${path} is readable or writable by others (mode ${(info.mode & 0o777).toString(8)}); refusing to use it`,
    );
  }
}

async function loadSession(): Promise<SessionFile | null> {
  const path = sessionPath();
  try {
    await assertPrivateFile(path);
  } catch (err) {
    // Loud, not silent: a session the CLI will not touch is worth saying out loud.
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
  try {
    const raw = await readFile(path, "utf8");
    return SessionFileSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * A session is only the session for the issuer that minted it, and only until it
 * expires. Reusing it against another issuer would forward one host's bearer to
 * another host named by an environment variable.
 */
function sessionFor(
  session: SessionFile | null,
  issuer: string,
): SessionFile | null {
  if (!session) return null;
  if (trimSlash(session.issuer) !== trimSlash(issuer)) return null;
  if (session.expiresAt !== undefined && session.expiresAt <= Date.now())
    return null;
  return session;
}

async function saveSession(session: SessionFile): Promise<void> {
  const path = sessionPath();
  // `mode` on writeFile only applies when the file is created, so a file left
  // behind at 0644 by an earlier version would keep those bits forever.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(session), { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

async function clearSession(): Promise<void> {
  try {
    await rm(sessionPath(), { force: true });
  } catch {
    // ignore
  }
}

function emit(flags: { json: boolean }, human: string, data: unknown): void {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(redactSecrets(data), null, 2)}\n`);
  } else {
    process.stdout.write(`${human}\n`);
  }
}

function publicKeyJktPlaceholder(): string {
  return createHash("sha256")
    .update(randomBytes(32))
    .digest("base64url")
    .slice(0, 43);
}

export async function runCli(
  argv: string[],
  deps?: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    openBrowser?: (url: string) => void;
  },
): Promise<number> {
  let command: ParsedCommand;
  try {
    command = parseArgs(argv);
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  if (command.name === "help") {
    process.stdout.write(helpText());
    return 0;
  }

  const issuer = command.flags.issuer ?? defaultIssuer();
  const api = command.flags.api ?? defaultApi(issuer);
  const clientId = command.flags.clientId ?? "opensesame-cli";
  const fetchImpl = deps?.fetchImpl ?? fetch;

  try {
    return await dispatch(command, { issuer, api, clientId, fetchImpl, deps });
  } catch (err) {
    // A refused endpoint or a failed exchange is a message, not a stack trace.
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

async function dispatch(
  command: Exclude<ParsedCommand, { name: "help" }>,
  ctx: {
    issuer: string;
    api: string;
    clientId: string;
    fetchImpl: typeof fetch;
    deps:
      | {
          fetchImpl?: typeof fetch;
          sleep?: (ms: number) => Promise<void>;
          openBrowser?: (url: string) => void;
        }
      | undefined;
  },
): Promise<number> {
  const { issuer, api, clientId, fetchImpl, deps } = ctx;

  switch (command.name) {
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
          ...(Number.isNaN(expiresAt) ? {} : { expiresAt }),
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
          ...(deps?.openBrowser ? { openBrowser: deps.openBrowser } : {}),
        });
        await saveSession({
          accessToken: tokens.access_token,
          ...(tokens.refresh_token !== undefined
            ? { refreshToken: tokens.refresh_token }
            : {}),
          ...(tokens.id_token !== undefined
            ? { idToken: tokens.id_token }
            : {}),
          ...(tokens.expires_in !== undefined
            ? { expiresAt: Date.now() + tokens.expires_in * 1000 }
            : {}),
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
        ...(deps?.sleep ? { sleep: deps.sleep } : {}),
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
          : {}),
        ...(tokens.id_token !== undefined ? { idToken: tokens.id_token } : {}),
        ...(tokens.expires_in !== undefined
          ? { expiresAt: Date.now() + tokens.expires_in * 1000 }
          : {}),
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
      const session = sessionFor(await loadSession(), issuer);
      const cp = createControlPlaneClient({
        baseUrl: api,
        ...(session ? { accessToken: session.accessToken } : {}),
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
      // The local file goes either way; only a session minted here can be revoked.
      const session = sessionFor(await loadSession(), issuer);
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
      }
      await clearSession();
      emit(command.flags, "Signed out.", { ok: true });
      return 0;
    }

    case "whoami": {
      const session = sessionFor(await loadSession(), issuer);
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
      const session = sessionFor(await loadSession(), issuer);
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
      const session = sessionFor(await loadSession(), issuer);
      const cp = createControlPlaneClient({
        baseUrl: api,
        ...(session ? { accessToken: session.accessToken } : {}),
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
        publicKeyJkt: publicKeyJktPlaceholder(),
      });
      emit(
        command.flags,
        "Anonymous agent registered. Complete claim in the console.",
        redactSecrets(agent),
      );
      return 0;
    }

    case "host-health": {
      const host = createApiClient({
        baseUrl: command.hostUrl,
        fetchImpl,
      });
      const health = await host.health();
      const daemon = await host.probeDaemon();
      emit(
        command.flags,
        health.ok
          ? `Host API up. Daemon ${daemon.available ? "available" : "unavailable"}.`
          : "Host API unreachable.",
        { health, daemon },
      );
      return health.ok ? 0 : 1;
    }

    case "host-discover": {
      const host = createApiClient({
        baseUrl: command.hostUrl,
        fetchImpl,
      });
      const discovery = await host.discover();
      emit(command.flags, `Discovery source: ${discovery.source}`, discovery);
      return discovery.source === "none" ? 1 : 0;
    }

    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      return 1;
    }
  }
}

export { parseArgs, helpText, SessionFileSchema };
