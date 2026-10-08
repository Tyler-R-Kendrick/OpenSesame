/** A required CLI template is a lower size bound, never an authority or artifact. */
import { resolve } from "node:path";

export const MAX_CANARY_CONFIGURATION_BYTES = 4096;
export function cliCanaryServer(output: string) {
  return {
    command: "opensesame-id" as const,
    args: ["canary", "serve", "--config", resolve(output)],
  };
}
export function assertCanaryExportOutputFits(output: string): void {
  // Every exported configuration contains this exact branch. Actual artifact
  // fields add bytes, so fitting here still requires the final full check.
  const lowerBound = `${JSON.stringify(
    { mcpServers: { OpenSesameCanary: cliCanaryServer(output) } },
    null,
    2,
  )}\n`;
  if (Buffer.byteLength(lowerBound, "utf8") > MAX_CANARY_CONFIGURATION_BYTES)
    throw new Error("Canary configuration exceeds 4 KiB.");
}
