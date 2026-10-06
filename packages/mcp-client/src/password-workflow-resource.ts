/** Human handoffs, without fetching vault state or accepting credential values. */
export const PASSWORD_WORKFLOW_RESOURCE =
  "opensesame://guides/password-workflows";
export const passwordWorkflowGuide = {
  title: "Password workflows and human approval",
  custody:
    "This MCP client has no password-store custody. It cannot read or approve credentials.",
  vault:
    "https://tyler-r-kendrick.github.io/OpenSesame/vault?workflow=password",
  actions: ["create", "compare", "update", "read", "env-resolve"].map(
    (action) => ({
      action,
      humanUrl: `https://tyler-r-kendrick.github.io/OpenSesame/vault?workflow=password&workflowAction=${action}`,
    }),
  ),
  discovery:
    "In the unlocked PWA, find references, inventory, organization audit and reference-only env templates use your local vault. Account credentials remain attached to their selected sign-in method; choose the Account and method in the human vault UI. Pepper-derived and Sphinx credentials require their own human input and are not downgraded into stored passwords. WebMCP exposes metadata workflows on that page.",
  requests: "https://tyler-r-kendrick.github.io/OpenSesame/access/requests",
  approvals:
    "Access Requests reviews Identity and local-vault requests. Native provider requests require the native human approval path; this MCP resource grants no authority.",
  native:
    "Access Requests prepares shell-safe opensesame-id lease approve commands for an exact destination and bounded expiry/use budget. After human native approval, enter the returned lease ID for request, lease status and lease revoke commands. The browser and this guide execute none of these commands. Native secret reads and process execution stay on the human CLI.",
} as const;
