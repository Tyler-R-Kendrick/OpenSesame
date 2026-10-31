import { randomUUID } from "node:crypto";
import { AgentClient } from "@opensesame/agent-client";
import { domainMatchScore } from "@opensesame/app-core/lib/site-broker.js";
import type { WebStorage } from "@opensesame/app-core/ports.js";
import {
  CandidateCustody,
  type CheckpointJournal,
  DurableJournal,
  DurableResetRunner,
  type ResetAction,
  type ResetRun,
  actionForPrimitive,
  assertResetGrant,
  fixedGrants,
} from "@opensesame/cua-password-reset";
import type { AuthorityGrant } from "@opensesame/os-domain";
import { emit } from "./output.js";
import {
  type ResetApprovalSession,
  openResetApprovals,
} from "./password-reset-approvals.js";
import { loadResetConfiguration } from "./password-reset-config.js";
import { SealedCheckpointJournal } from "./password-reset-journal.js";
import type { PasswordResetCommand } from "./password-reset-parse.js";
import {
  RESET_LAUNCH_AUDIENCE,
  type ResetEffectsLoader,
  loadResetEffects,
} from "./password-reset-runtime.js";
import {
  type ResetVault,
  type ResetVaultDependencies,
  openResetVault,
} from "./password-reset-vault.js";
import { readPasswordFromTty } from "./tty-password.js";

export interface PasswordResetDependencies extends ResetVaultDependencies {
  loadConfiguration?: typeof loadResetConfiguration;
  openVault?: (
    itemId: string,
    deps: ResetVaultDependencies,
  ) => Promise<ResetVault>;
  createJournal?: (storage: WebStorage) => CheckpointJournal;
  loadEffects?: ResetEffectsLoader;
  createAgent?: () => Pick<AgentClient, "headers" | "forget">;
  openApprovals?: (
    command: PasswordResetCommand,
  ) => Promise<ResetApprovalSession>;
  now?: () => Date;
  newRunId?: () => string;
}

interface ResetResources {
  agent?: Pick<AgentClient, "headers" | "forget">;
  candidate?: CandidateCustody;
  vault?: ResetVault;
  approvals?: ResetApprovalSession;
}

type LoadedReset = Awaited<ReturnType<typeof loadResetConfiguration>>;
type ResetApproval = Awaited<ReturnType<ResetApprovalSession["approve"]>>;
type ResetSharedItem = NonNullable<ResetApproval["items"]>[number];

export async function runPasswordReset(
  command: PasswordResetCommand,
  deps: PasswordResetDependencies = {},
): Promise<number> {
  if (command.action === "configure")
    return validateResetConfiguration(command, deps);
  return executePasswordReset(command, deps);
}

async function validateResetConfiguration(
  command: PasswordResetCommand,
  deps: PasswordResetDependencies,
): Promise<number> {
  const loaded = await (deps.loadConfiguration ?? loadResetConfiguration)(
    command,
  );
  emit(command.flags, "Password reset configuration validated.", {
    ok: true,
    origin: loaded.config.origin,
    model: loaded.config.runtime.model ?? "none (bundled local runtime)",
  });
  return 0;
}

async function executePasswordReset(
  command: PasswordResetCommand,
  deps: PasswordResetDependencies,
): Promise<number> {
  const resources: ResetResources = {};
  try {
    return await runReset(command, deps, resources);
  } catch (error) {
    throw new Error(`password-reset ${command.action} failed`, {
      cause: error,
    });
  } finally {
    resources.candidate?.forget();
    resources.agent?.forget();
    resources.vault?.store.lock();
    await resources.approvals?.close();
  }
}

async function runReset(
  command: PasswordResetCommand,
  deps: PasswordResetDependencies,
  resources: ResetResources,
): Promise<number> {
  const loaded = await (deps.loadConfiguration ?? loadResetConfiguration)(
    command,
  );
  const now = deps.now ?? (() => new Date());
  const approvals = await (deps.openApprovals ?? openResetApprovals)(command);
  resources.approvals = approvals;
  const id = resetRunId(command, loaded, deps);
  const itemId = required(command.itemId ?? loaded.config.itemId, "item id");
  let run = baseRun(id, itemId, loaded, now);
  const metadata = await approvals.approve(
    "password_reset.domain_metadata.list",
    run,
    loaded,
  );
  assertSharedItem(metadata, run, itemId);
  run.grantIds["password_reset.domain_metadata.list"] = metadata.grant.id;
  const vault = await (deps.openVault ?? openResetVault)(itemId, deps);
  resources.vault = vault;
  const journal = new DurableJournal(
    (deps.createJournal ?? ((local) => new SealedCheckpointJournal(local)))(
      vault.local,
    ),
  );
  run = await prepareRun(command, loaded, journal, now, id);
  run.grantIds["password_reset.domain_metadata.list"] = metadata.grant.id;
  const grantProvider = await approveResetActions(
    command,
    run,
    loaded,
    approvals,
    metadata,
  );
  const candidate = createCandidate(vault, deps, grantProvider, run, now);
  resources.candidate = candidate;
  const agentClient = (
    deps.createAgent ?? (() => new AgentClient(RESET_LAUNCH_AUDIENCE))
  )();
  resources.agent = agentClient;
  const effects = await (deps.loadEffects ?? loadResetEffects)({
    run,
    loaded,
    store: vault.store,
    item: vault.item,
    candidate,
    agent: agentClient,
  });
  const runner = new DurableResetRunner(journal, effects, grantProvider, now);
  const result = await advance(command.action, runner, run);
  return reportResetResult(command, approvals, result);
}

function resetRunId(
  command: PasswordResetCommand,
  loaded: LoadedReset,
  deps: PasswordResetDependencies,
): string {
  if (command.action !== "run")
    return required(command.runId ?? loaded.config.runId, "run id");
  return (
    command.runId ?? loaded.config.runId ?? (deps.newRunId ?? randomUUID)()
  );
}

function assertSharedItem(
  metadata: ResetApproval,
  run: ResetRun,
  itemId: string,
): void {
  const shared = metadata.items?.some(
    (item: ResetSharedItem) =>
      item.id === itemId &&
      item.origins.some(
        (rule: string) => domainMatchScore(run.origin, rule) > 0,
      ),
  );
  if (!shared)
    throw new Error("The exact reset item is not shared for this origin");
}

async function approveResetActions(
  command: PasswordResetCommand,
  run: ResetRun,
  loaded: LoadedReset,
  approvals: ResetApprovalSession,
  metadata: ResetApproval,
): Promise<ReturnType<typeof fixedGrants>> {
  const grants = new Map<ResetAction, AuthorityGrant>([
    ["password_reset.domain_metadata.list", metadata.grant],
  ]);
  for (const action of requiredActions(command, run)) {
    const approved = await approvals.approve(action, run, loaded);
    grants.set(action, approved.grant);
    run.grantIds[action] = approved.grant.id;
  }
  return fixedGrants(Object.fromEntries(grants));
}

function createCandidate(
  vault: ResetVault,
  deps: PasswordResetDependencies,
  grantProvider: ReturnType<typeof fixedGrants>,
  run: ResetRun,
  now: () => Date,
): CandidateCustody {
  return new CandidateCustody(
    vault.method,
    () =>
      (deps.readPassword ?? readPasswordFromTty)(
        "Pepper for this password reset: ",
      ),
    () =>
      assertResetGrant(
        grantProvider.grant("password_reset.password.produce", run),
        run,
        "password_reset.password.produce",
        now(),
      ),
  );
}

async function reportResetResult(
  command: PasswordResetCommand,
  approvals: ResetApprovalSession,
  result: ResetRun,
): Promise<number> {
  if (result.status === "awaiting_human")
    await approvals.status(
      result,
      "password_reset.human.takeover",
      "takeover_requested",
    );
  emit(command.flags, `Password reset ${result.status} (${result.id}).`, {
    ok: result.status === "succeeded",
    id: result.id,
    status: result.status,
    cursor: result.cursor,
  });
  return result.status === "failed" ? 1 : 0;
}

function baseRun(
  id: string,
  itemId: string,
  loaded: Awaited<ReturnType<typeof loadResetConfiguration>>,
  now: () => Date,
): ResetRun {
  const origin = new URL(loaded.config.origin).origin;
  return {
    id,
    domain: new URL(origin).hostname,
    origin,
    itemId,
    transport: loaded.config.transport,
    grantIds: {},
    cursor: 0,
    status: "running",
    recipe: loaded.recipe,
    updatedAt: now().toISOString(),
  };
}

async function prepareRun(
  command: PasswordResetCommand,
  loaded: Awaited<ReturnType<typeof loadResetConfiguration>>,
  journal: DurableJournal,
  now: () => Date,
  id: string,
): Promise<ResetRun> {
  const itemId = required(command.itemId ?? loaded.config.itemId, "itemId");
  if (command.action === "run") {
    if ((await journal.events(id)).length > 0)
      throw new Error("Run already exists");
    return baseRun(id, itemId, loaded, now);
  }
  const restored = await journal.restore(id);
  if (
    restored.origin !== new URL(loaded.config.origin).origin ||
    restored.itemId !== itemId ||
    restored.transport !== loaded.config.transport ||
    JSON.stringify(restored.recipe) !== JSON.stringify(loaded.recipe)
  )
    throw new Error("Checkpoint does not match the approved configuration");
  if (
    command.action === "resume" &&
    restored.status === "reconciliation_required"
  )
    throw new Error("Run requires reconciliation");
  if (
    command.action === "reconcile" &&
    restored.status !== "reconciliation_required"
  )
    throw new Error("Run does not require reconciliation");
  if (restored.status === "succeeded" || restored.status === "failed")
    throw new Error("Run is already terminal");
  return restored;
}

function requiredActions(
  command: PasswordResetCommand,
  run: ResetRun,
): ResetAction[] {
  if (command.action === "reconcile")
    return [
      "password_reset.run.reconcile",
      "password_reset.run.compensate",
      "password_reset.item.use",
      "password_reset.password.produce",
    ];
  const actions = new Set<ResetAction>([
    "password_reset.item.use",
    "password_reset.password.produce",
    "password_reset.runtime.execute",
    "password_reset.model.plan",
    "password_reset.human.takeover",
  ]);
  for (const step of run.recipe.steps)
    actions.add(actionForPrimitive(step.primitive));
  if (run.transport === "proxy" || run.recipe.proxySubstitution)
    actions.add("password_reset.proxy.substitute");
  return [...actions];
}

async function advance(
  action: PasswordResetCommand["action"],
  runner: DurableResetRunner,
  run: ResetRun,
): Promise<ResetRun> {
  if (action === "run") return runner.start(run);
  if (action === "reconcile") return runner.reconcile(run);
  return run.status === "awaiting_human"
    ? runner.resumeAfterHuman(run)
    : runner.resume(run);
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
