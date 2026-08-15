import { assertSafeMetadataUrl } from "@opensesame/oauth-provider";
import { FuzzedDataProvider } from "./provider.js";

export function fuzz(data: Buffer): void {
  const p = new FuzzedDataProvider(data);
  const raw = p.consumeRemainingAsString();
  try {
    const url = assertSafeMetadataUrl(raw);
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host === "169.254.169.254" ||
      host === "metadata.google.internal"
    ) {
      throw new Error(`private/metadata host accepted: ${host}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("private/metadata")) {
      throw err;
    }
  }
}
