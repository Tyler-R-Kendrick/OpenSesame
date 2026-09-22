/**
 * The contract between the core shell and an optional capability module
 * (ownership.md §4.2 / §4.3). Types only, plus the one error the loader,
 * registrars and authority checks all throw.
 *
 * A module receives exactly the ports in `ApprovedCapabilityContext` — never
 * the vault store's root material and never an unbounded fetch — and it
 * contributes to the shell only through `register`, whose entries are data
 * plus already-imported components. Icons are string keys the shell resolves
 * so a module never ships an SVG the core has to trust.
 */

import type {
  ActivationLease,
  CapabilityId,
  ContributionKind,
  RegistrationHandle,
  RuntimeHandle,
} from "@opensesame/capability-composition";
import type { WebMcpToolSpec } from "@opensesame/webmcp";
import type { ComponentType } from "react";
import type { GuideGoalDescriptor } from "../../tutorial/registry/goals.js";
import type { GuideRouteDescriptor } from "../../tutorial/registry/routes.js";
import type { GuideTargetDescriptor } from "../../tutorial/registry/targets.js";
import type { ParsedRuntimeConfig } from "../runtime-config.js";

/** Icon keys the shell knows how to draw (`components/Icons.tsx`). */
export type IconName =
  | "vault"
  | "site"
  | "connection"
  | "authority"
  | "settings"
  | "bell"
  | "login"
  | "user"
  | "passkey"
  | "card"
  | "secret"
  | "note"
  | "shield"
  | "lock"
  | "clock"
  | "folder"
  | "star"
  | "support"
  | "help"
  | "info"
  | "alert";

/** Props a section's rail tree receives from the shell. */
export type TreeProps = Readonly<{ pathname: string }>;

export type SectionContribution = Readonly<{
  id: string;
  to: string;
  label: string;
  segment: string;
  jump: string;
  icon: IconName;
  order: number;
  Tree?: ComponentType<TreeProps>;
}>;

export type RouteContribution = Readonly<{
  id: string;
  path: string;
  element: ComponentType;
  framed: boolean;
  order: number;
  /**
   * Where the route may render. `unlocked` (default) is inside the shell
   * behind the vault gate; `any` also serves it on a locked device, the way
   * the federation return does — for popups and claim pages that hold no key.
   */
  gate?: "unlocked" | "any";
}>;

export type SettingsCategoryContribution = Readonly<{
  id: string;
  label: string;
  guideId: string;
  Panel: ComponentType;
  order: number;
}>;

export type SetupPanelContribution = Readonly<{
  id: string;
  tab: string;
  rail: string;
  Panel: ComponentType;
  order: number;
}>;

export type CommandPathContribution = Readonly<{ path: string; label: string }>;
export type KeymapJumpContribution = Readonly<{ key: string; path: string }>;

export type ItemKindContribution = Readonly<{
  kind: string;
  label: string;
  segment: string;
  Icon?: ComponentType;
  order: number;
}>;

export type BackgroundJobContribution = Readonly<{
  id: string;
  start: (signal: AbortSignal) => void;
}>;

export type UnlockEffectContext = Readonly<{
  tomb: string;
  guest: boolean;
  signal: AbortSignal;
}>;

export type UnlockEffectContribution = Readonly<{
  id: string;
  run: (ctx: UnlockEffectContext) => Promise<void>;
}>;

export type ContributionEntryMap = {
  section: SectionContribution;
  route: RouteContribution;
  "settings-category": SettingsCategoryContribution;
  "setup-panel": SetupPanelContribution;
  "command-path": CommandPathContribution;
  "keymap-jump": KeymapJumpContribution;
  "tutorial-target": GuideTargetDescriptor;
  "tutorial-goal": GuideGoalDescriptor;
  "tutorial-route": GuideRouteDescriptor;
  "item-kind": ItemKindContribution;
  "webmcp-tool": WebMcpToolSpec;
  "background-job": BackgroundJobContribution;
  "unlock-effect": UnlockEffectContribution;
};

export type ContributionEntry<K extends ContributionKind> =
  ContributionEntryMap[K];

/**
 * Destination-validated fetch. The implementation (S18, `egress.ts`) checks
 * the destination against the plan's network envelope and the capability's
 * declared egress classes; `egress-default.ts` allows same-origin only.
 */
export type EgressPort = Readonly<{
  fetch(
    input: URL | string,
    init: RequestInit | undefined,
    meta: { capability: CapabilityId; purpose: string },
  ): Promise<Response>;
}>;

export type ApprovedCapabilityContext = Readonly<{
  lease: ActivationLease;
  register: <K extends ContributionKind>(
    kind: K,
    entry: ContributionEntry<K>,
  ) => RegistrationHandle;
  /** Parsed data; the module applies its own endpoints. */
  runtimeConfig: ParsedRuntimeConfig;
  /** `kvHydrate` for the module's own keys. */
  hydrate: (keys: readonly string[]) => Promise<void>;
  vault: Readonly<{ tomb: string | null; guest: boolean }>;
  egress: EgressPort;
}>;

export type CapabilityRuntime = Readonly<{
  capability: CapabilityId;
  activate(ctx: ApprovedCapabilityContext): Promise<RuntimeHandle>;
}>;

export type CapabilityModule = Readonly<{ capabilityRuntime: CapabilityRuntime }>;

export type CapabilityDenialCode =
  | "NOT_DISTRIBUTED"
  | "NOT_APPROVED"
  | "STALE_LEASE"
  | "LEASE_UNBOUND"
  | "INVALID_MODULE"
  | "NOT_RESOLVED";

/** Thrown before any handler import when authority is missing or stale. */
export class CapabilityDenied extends Error {
  readonly code: CapabilityDenialCode;
  readonly subject: string;

  constructor(code: CapabilityDenialCode, subject: string) {
    super(`capability denied: ${code} (${subject})`);
    this.name = "CapabilityDenied";
    this.code = code;
    this.subject = subject;
  }
}

/** Narrow a caught value without trusting its shape. */
export function isCapabilityDenied(error: unknown): error is CapabilityDenied {
  return error instanceof CapabilityDenied;
}
