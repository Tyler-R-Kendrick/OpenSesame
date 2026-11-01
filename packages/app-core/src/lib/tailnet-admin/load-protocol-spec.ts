import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "@opensesame/os-domain";
import Handlebars from "handlebars";
import {
  syntheticTailscaleAuthKeyControlId,
  syntheticTailscaleAuthKeyForControlId,
} from "../synthetic-tailscale-key.js";

const specDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../spec/conformance",
);
const templatePath = join(specDir, "tailnet-admin-protocol.json.hbs");

export type TailnetProtocolFixture = {
  mintAuthKeyId: string;
  mintAuthKey: string;
};

export function defaultTailnetProtocolFixture(): TailnetProtocolFixture {
  const mintAuthKeyId = syntheticTailscaleAuthKeyControlId();
  const mintAuthKey = syntheticTailscaleAuthKeyForControlId(mintAuthKeyId);
  return { mintAuthKeyId, mintAuthKey };
}

/** Load the tailnet admin protocol spec with runtime-generated key material. */
export function loadTailnetAdminProtocolSpec(
  fixture: TailnetProtocolFixture = defaultTailnetProtocolFixture(),
): JsonObject {
  const source = readFileSync(templatePath, "utf8");
  const render = Handlebars.compile(source, {
    strict: true,
    noEscape: true,
  });
  return JSON.parse(
    render({
      mintAuthKeyId: fixture.mintAuthKeyId,
      mintAuthKey: fixture.mintAuthKey,
    }),
  ) as JsonObject;
}
