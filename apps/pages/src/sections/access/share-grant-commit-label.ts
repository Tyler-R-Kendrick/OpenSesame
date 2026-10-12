export function shareGrantCommitLabel(kind: string | undefined): string {
  return kind === "agent" || kind === "application"
    ? "Request approval"
    : "Grant";
}
