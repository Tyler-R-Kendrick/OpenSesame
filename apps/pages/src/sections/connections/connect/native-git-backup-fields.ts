/** One optional repository target form for native Contents backup providers. */
import type { NativeField } from "./native-connector-ui.js";
export function nativeGitBackupFields(permission: string): NativeField[] {
  return [
    {
      id: "backup_owner",
      label: "Backup repository owner",
      kind: "text",
      secret: false,
      required: false,
      help: `For vault backups, supply owner, repository and an existing branch. ${permission}`,
    },
    {
      id: "backup_repo",
      label: "Backup repository name",
      kind: "text",
      secret: false,
      required: false,
    },
    {
      id: "backup_branch",
      label: "Backup repository branch",
      kind: "text",
      secret: false,
      required: false,
      help: "Use an existing branch. Encrypted backup envelopes are limited to 512 KiB.",
    },
  ];
}
