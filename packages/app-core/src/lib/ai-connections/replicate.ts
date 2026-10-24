import { z } from "zod";
import { aiConnectionBase } from "./configuration.js";
import { checkAiResponse, readAiJson } from "./http.js";
import {
  type ReplicateConnection,
  type ReplicateInput,
  type ReplicatePrediction,
  ReplicatePredictionSchema,
  replicatePredictionTarget,
} from "./replicate-types.js";
import { AiConnectionError, type AiConnectionTransport } from "./types.js";

/** Official REST predictions protocol; never follows provider-returned URLs. */
function predictionPath(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw new AiConnectionError("configuration", "Invalid prediction ID.");
  return `predictions/${id}`;
}

function inputBody(input: ReplicateInput) {
  try {
    const parsed = z.record(z.string(), z.json()).parse(input);
    if (new TextEncoder().encode(JSON.stringify(parsed)).length > 32768)
      throw new Error("Input too large");
    return parsed;
  } catch {
    throw new AiConnectionError(
      "configuration",
      "Prediction input must be a JSON object of at most 32 KiB.",
    );
  }
}

function headers(config: ReplicateConnection): Headers {
  const result = new Headers({ "content-type": "application/json" });
  if (config.authentication === "api-key") {
    if (
      !config.apiKey ||
      config.apiKey.length > 16384 ||
      !/^[!-~]+$/.test(config.apiKey)
    )
      throw new AiConnectionError(
        "authentication",
        "Enter a valid Replicate API token.",
      );
    if (
      config.apiKey.length >= 4 &&
      [config.baseUrl, config.model].some((value) =>
        value.includes(config.apiKey),
      )
    )
      throw new AiConnectionError(
        "configuration",
        "Keep the API token out of public connection fields.",
      );
    result.set("authorization", `Bearer ${config.apiKey}`);
  }
  return result;
}

async function request(
  config: ReplicateConnection,
  path: string,
  method: "GET" | "POST",
  transport: AiConnectionTransport,
  check: () => void,
  body?: ReplicateInput,
  expectedId?: string,
): Promise<ReplicatePrediction> {
  const url = new URL(path, aiConnectionBase(config.baseUrl));
  const assert = () => {
    check();
    transport.assertCurrent();
    transport.signal.throwIfAborted();
  };
  const init: RequestInit = {
    method,
    headers: headers(config),
    signal: AbortSignal.any([transport.signal, AbortSignal.timeout(60_000)]),
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  assert();
  let response: Response;
  try {
    response = await transport.fetch(url, init);
  } catch {
    assert();
    throw new AiConnectionError(
      "network",
      "Could not reach Replicate. Check TLS, network permissions and CORS for this origin.",
    );
  }
  assert();
  checkAiResponse(response);
  const parsed = ReplicatePredictionSchema.safeParse(
    await readAiJson(response, assert),
  );
  if (
    !parsed.success ||
    (expectedId !== undefined && parsed.data.id !== expectedId)
  )
    throw new AiConnectionError(
      "response",
      "Replicate returned an invalid prediction response.",
    );
  if (config.apiKey && JSON.stringify(parsed.data).includes(config.apiKey))
    throw new AiConnectionError(
      "response",
      "The AI service returned credential material.",
    );
  assert();
  return parsed.data;
}

export function createReplicatePrediction(
  config: ReplicateConnection,
  input: ReplicateInput,
  transport: AiConnectionTransport,
  check: () => void,
) {
  const target = replicatePredictionTarget(config.model);
  const body: ReplicateInput = { input: inputBody(input) };
  if (target.version) body.version = target.version;
  return request(config, target.path, "POST", transport, check, body);
}

export function getReplicatePrediction(
  config: ReplicateConnection,
  id: string,
  transport: AiConnectionTransport,
  check: () => void,
) {
  return request(
    config,
    predictionPath(id),
    "GET",
    transport,
    check,
    undefined,
    id,
  );
}

export function cancelReplicatePrediction(
  config: ReplicateConnection,
  id: string,
  transport: AiConnectionTransport,
  check: () => void,
) {
  return request(
    config,
    `${predictionPath(id)}/cancel`,
    "POST",
    transport,
    check,
    undefined,
    id,
  );
}
