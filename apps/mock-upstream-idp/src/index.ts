import { createMockUpstreamIdp } from "./server.js";
import { readMockIdpConfig } from "./config.js";

export { createMockUpstreamIdp } from "./server.js";
export { readMockIdpConfig, createMockIdpKeys, type MockIdpConfig } from "./config.js";

export async function main(): Promise<void> {
  const config = readMockIdpConfig();
  const idp = await createMockUpstreamIdp(config);
  const issuer = await idp.listen();
  console.log(`@opensesame/mock-upstream-idp listening at ${issuer}`);
  console.log(`  discovery: ${issuer}/.well-known/openid-configuration`);
  console.log(`  seed client: ${config.clientId}`);
  console.log(`  test user: ${config.testUser.sub} <${config.testUser.email}>`);

  const shutdown = async () => {
    await idp.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
