import { type Destination, createApiCredential } from "./create.js";
import * as discovery from "./discover.js";
import * as environment from "./env.js";
import { type PasswordOptions, password } from "./password.js";
import type { PasswordAgentPort, Scope } from "./transport.js";
export * from "./transport.js";
export * from "./discover.js";
export * from "./env.js";
export * from "./create.js";
export * from "./password.js";
export class PasswordAgent {
  constructor(readonly port: PasswordAgentPort) {}
  find(queries: readonly string[], scope: Scope = {}) {
    return discovery.find(this.port, queries, scope);
  }
  inventory(scope: Scope = {}) {
    return discovery.inventory(this.port, scope);
  }
  audit(scope: Scope = {}, now?: Date) {
    return discovery.audit(this.port, scope, now);
  }
  createApiCredential(destination: Destination, value: string) {
    return createApiCredential(this.port, destination, value);
  }
  password(options: PasswordOptions, value: string) {
    return password(this.port, options, value);
  }
  read(reference: string) {
    return environment.read(this.port, reference);
  }
  resolveEnv(content: string) {
    return environment.resolveEnv(content, async (refs) => {
      if (refs.some((reference) => !reference.startsWith("op://")))
        throw new Error("1Password resolution requires op:// references");
      if (!this.port.readMany)
        throw new Error("Batched secret resolution is unavailable");
      try {
        return await this.port.readMany(refs);
      } catch {
        throw new Error(
          "Batched secret resolution failed (details suppressed)",
        );
      }
    });
  }
  run(
    assignments: readonly environment.Assignment[],
    command: readonly string[],
  ) {
    return environment.run(this.port, assignments, command);
  }
  runFile(file: string, command: readonly string[], content: string) {
    return environment.runFile(this.port, file, command, content);
  }
}

export * as Auth from "./auth.js";
export * as ServiceAccount from "./service-account.js";

export * from "./doctor.js";
export * from "./request.js";
export * from "./lease.js";
export * from "./lease-grant.js";
export * from "./request-leased.js";
