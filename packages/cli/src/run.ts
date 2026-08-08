import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createControlPlaneClient,
  DeviceFlowClient,
  loopbackLogin,
  redactSecrets,
} from "@opensesame/sdk-cli";
import { createApiClient } from "@opensesame/api-client";
import { createHash, randomBytes } from "node:crypto";
import {
  helpText,
  parseArgs,
  SessionFileSchema,
  type ParsedCommand,
  type SessionFile,
} from "./parse.js";

function defaultIssuer(): string {
  return process.env.OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";
}

function defaultApi(issuer: string): string {
  return process.env.OPENSESAME_API_URL ?? issuer;
}

function sessionPath(): string {
  const base =
    process.env.XDG_RUNTIME_DIR ??
    process.env.OPENSESAME_STATE_DIR ??
    join(homedir(), ".config", "opensesame");
  return join(base, "identity-session.json");
}

async function loadSession(): Promise<SessionFile | null> {
  try {
    const raw = await readFile(sessionPath(), "utf8");
    return SessionFileSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function saveSession(session: SessionFile): Promise<void> {
  const path = sessionPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(session), { mode: 0o600 });
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
  return createHash("sha256").update(randomBytes(32)).digest("base64url").slice(0, 43);
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
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
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

  switch (command.name) {
    case "login": {
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
          ...(tokens.id_token !== undefined ? { idToken: tokens.id_token } : {}),
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
        process.stdout.write(`${device.formatInstructions(start)}\n\n`);
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
      const session = await loadSession();
      const cp = createControlPlaneClient({
        baseUrl: api,
        ...(session ? { accessToken: session.accessToken } : {}),
        fetchImpl,
      });
      const status = await cp.authStatus();
      emit(
        command.flags,
        status.authenticated
          ? "Authenticated."
          : "Not authenticated.",
        status,
      );
      return 0;
    }

    case "logout": {
      const session = await loadSession();
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
      const session = await loadSession();
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
      const session = await loadSession();
      if (!session) {
        process.stderr.write("Login required.\n");
        return 1;
      }
      if (!command.temporary) {
        process.stderr.write("Only --temporary projects are supported in this slice.\n");
        return 1;
      }
      const cp = createControlPlaneClient({
        baseUrl: api,
        accessToken: session.accessToken,
        fetchImpl,
      });
      const project = await cp.createTemporaryProject({ name: command.projectName });
      emit(command.flags, "Temporary project created.", redactSecrets(project));
      return 0;
    }

    case "claim-poll": {
      const session = await loadSession();
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
        process.stderr.write("Use --anonymous for provisional agent registration.\n");
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
