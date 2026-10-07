/** Closed, secret-free destinations: DOM values never become arbitrary URLs. */
export const WORKFLOW_DESTINATIONS = Object.freeze({
  inventory:
    "https://tyler-r-kendrick.github.io/OpenSesame/vault?workflow=password",
  create:
    "https://tyler-r-kendrick.github.io/OpenSesame/vault?workflow=password&workflowAction=create",
  compare:
    "https://tyler-r-kendrick.github.io/OpenSesame/vault?workflow=password&workflowAction=compare",
  update:
    "https://tyler-r-kendrick.github.io/OpenSesame/vault?workflow=password&workflowAction=update",
  read: "https://tyler-r-kendrick.github.io/OpenSesame/vault?workflow=password&workflowAction=read",
  "env-resolve":
    "https://tyler-r-kendrick.github.io/OpenSesame/vault?workflow=password&workflowAction=env-resolve",
  requests: "https://tyler-r-kendrick.github.io/OpenSesame/access/requests",
});
export type WorkflowSecurity = {
  permit(): string | undefined;
  requireProduction(): Promise<void>;
};
/** Pin this popup's permit before any awaited authorization or host operation. */
export async function requireWorkflowOwner(
  security: WorkflowSecurity,
  real: () => boolean,
) {
  const permit = security.permit();
  const check = () => {
    if (!permit || !real() || security.permit() !== permit)
      throw new Error("The popup session changed. Authenticate again.");
  };
  check();
  await security.requireProduction();
  check();
  return check;
}
/** Dispatch immediately after authorization, in the same original popup session. */
export function createWorkflowHandoff(
  security: WorkflowSecurity,
  real: () => boolean,
  createTab: (options: { url: string }) => Promise<void>,
) {
  return async (key: string) => {
    const destination = Object.entries(WORKFLOW_DESTINATIONS).find(
      ([id]) => id === key,
    )?.[1];
    if (!destination) throw new Error("Unknown vault task.");
    const check = await requireWorkflowOwner(security, real);
    check();
    await createTab({ url: destination });
  };
}
