import { createHash, randomBytes } from "node:crypto";
import { configuredEndpoint, overlapCast } from "@opensesame/os-domain";
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
import { type VaultDependencies, runVaultCommand } from "./vault-commands.js";
import { type VaultItemDependencies, runVaultItems } from "./vault-items.js";
import { type VaultSyncDependencies, runVaultSync } from "./vault-sync.js";

function defaultIssuer(): string {
  return process.env.OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";
}

interface RunDependencies
  extends VaultDependencies,
    VaultItemDependencies,
    VaultSyncDependencies,
    ParityDependencies {
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

function publicKeyJktPlaceholder(): string {
  return createHash("sha256")
    .update(randomBytes(32))
    .digest("base64url")
    .slice(0, 43);
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
    case "parity":
      return runParity(command, deps);
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
      // The local file goes either way; only a session minted here can be revoked.
      const session = await sessionFor(await loadSession(), issuer, fetchImpl);
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
        publicKeyJkt: publicKeyJktPlaceholder(),
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

    case "vault-sync":
      return runVaultSync(command, deps);

    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      return 1;
    }
  }
}

export { parseArgs, helpText, SessionFileSchema };
