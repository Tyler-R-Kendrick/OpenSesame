import type { PasswordAgentPort } from "./transport.js";
export interface DoctorContext {
  version: string;
  platform: string;
  runtime: string;
  auth:
    | "environment service account"
    | "saved service account"
    | "desktop app"
    | "saved service account (settings unreadable; use --desktop)";
}
export interface DoctorResult {
  version: string;
  platform: string;
  runtime: string;
  op: string | null;
  accounts: number | null;
  auth: DoctorContext["auth"];
  notes?: string[];
}
/** Takes an unauthenticated transport: never opens secure storage or accesses vaults. */
export async function doctor(port: PasswordAgentPort, context: DoctorContext) {
  let op: string | null = null;
  let accounts: number | null = null;
  try {
    op = (await port.invoke(["--version"], { timeoutMs: 5_000 })).trim();
  } catch {
    /* Availability is diagnostic data. */
  }
  if (op !== null) {
    try {
      const value: unknown = JSON.parse(
        await port.invoke(["account", "list", "--format", "json"], {
          timeoutMs: 5_000,
        }),
      );
      accounts = Array.isArray(value) ? value.length : 0;
    } catch {
      accounts = 0;
    }
  }
  const notes: string[] = [];
  if (op === null)
    notes.push(
      "Install the 1Password CLI: https://developer.1password.com/docs/cli/get-started/",
    );
  if (context.auth === "desktop app" && accounts === 0)
    notes.push(
      "Enable Settings > Developer > Integrate with 1Password CLI in the 1Password app.",
    );
  if (context.auth === "desktop app" && op !== null)
    notes.push(
      "Desktop approvals last per terminal session. Batch lookups or use a service account to avoid repeated prompts.",
    );
  const result: DoctorResult = { ...context, op, accounts };
  if (notes.length) result.notes = notes;
  return result;
}
