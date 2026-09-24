import { parseEnvSpecDotEnvFile } from "@env-spec/parser";
import { FuzzedDataProvider } from "./provider.js";

export function fuzz(data: Buffer): void {
  const p = new FuzzedDataProvider(data);
  const raw = p.consumeRemainingAsString();
  try {
    const parsed = parseEnvSpecDotEnvFile(raw);
    const text = JSON.stringify(parsed);
    if (
      /@sensitive/i.test(raw) &&
      /SUPERSECRET/.test(raw) &&
      text.includes("SUPERSECRET")
    ) {
      throw new Error("sensitive value leaked from env-spec parse");
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("leaked")) {
      throw err;
    }
  }
}
