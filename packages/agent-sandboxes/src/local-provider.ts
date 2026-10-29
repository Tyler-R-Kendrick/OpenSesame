/**
 * Local ephemeral provider: an agent-browser session on the user's own
 * device (see `createLocalSandbox`). No account, connection record, or
 * config file is required — this is the zero-provision default lane.
 */

import {
  type LocalSandboxOptions,
  createLocalSandbox,
} from "@opensesame/cua-password-reset";
import type {
  AllocatedSandbox,
  SandboxAllocationRequest,
  SandboxProvider,
} from "./types.js";

export type LocalProviderOptions = Omit<
  LocalSandboxOptions,
  "origin" | "extraAllowedDomains" | "session"
>;

export class LocalSandboxProvider implements SandboxProvider {
  readonly id = "local" as const;

  constructor(private readonly options: LocalProviderOptions = {}) {}

  async allocate(request: SandboxAllocationRequest): Promise<AllocatedSandbox> {
    const options: LocalSandboxOptions = {
      ...this.options,
      origin: request.origin,
      extraAllowedDomains: request.extraAllowedDomains ?? [],
    };
    if (request.session) options.session = request.session;
    const sandbox = createLocalSandbox(options);
    return {
      provider: this.id,
      session: sandbox.session,
      browser: sandbox.browser,
      allowedDomains: sandbox.allowedDomains,
      close: () => sandbox.close(),
    };
  }
}
