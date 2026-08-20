import { overlapCast, type JsonObject } from "@opensesame/os-domain";

async function connectDefault(options: JsonObject) {
  const module = await import("@tursodatabase/sync-wasm/vite");
  return overlapCast(await module.connect(options));
}

export const tursoConnectSeams = {
  connect: connectDefault,
};

export async function connectTurso(options: JsonObject) {
  return tursoConnectSeams.connect(options);
}
