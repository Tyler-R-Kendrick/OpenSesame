import { randomBytes } from "node:crypto";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
      OPENSESAME_OPERATOR_TOKEN: randomBytes(32).toString("base64url"),
      OPENSESAME_MAPPING_RESOLVE_TOKEN: randomBytes(32).toString("base64url"),
      OPENSESAME_TRUSTED_UPSTREAMS:
        "https://shoo.dev,http://127.0.0.1:9090,http://localhost:9090",
      OPENSESAME_CORS_ORIGINS: "http://127.0.0.1:5180,http://localhost:5180",
    },
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
