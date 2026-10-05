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
import type { Folder, VaultItem } from "@opensesame/vault-core";
import type { WebMcpToolSpec } from "@opensesame/webmcp";
import type { ComponentType, ReactNode } from "react";
import type { VirtualFileProvider } from "../../sections/settings/virtual-files.js";
import type { GuideGoalDescriptor } from "../../tutorial/registry/goals.js";
import type { GuideRouteDescriptor } from "../../tutorial/registry/routes.js";
import type { GuideTargetDescriptor } from "../../tutorial/registry/targets.js";
import type { InterpretResult } from "../command-bar/types.js";
import type { ParsedRuntimeConfig } from "../runtime-config.js";
import type { DraftLabels } from "../vault/new-draft.js";

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
  /**
   * The panels `Panel` always draws, in page order: the rail lists them
   * under the tab, so a contributed tab opens like the core ones do. `id` is
   * each panel's root element id.
   */
  panels?: readonly Readonly<{ id: string; label: string }>[];
  /**
   * The category's files beyond its own `config.yaml` (ADR 0134): what
   * Settings' file viewer lists and writes for it. The Form is drawn from
   * the same files.
   */
  files?: VirtualFileProvider;
}>;

export type SetupPanelContribution = Readonly<{
  id: string;
  tab: string;
  rail: string;
  Panel: ComponentType;
  order: number;
}>;

/**
 * A panel a capability draws inside a settings category the core already
 * has. A category is a destination; a panel is a block within one, so an
 * optional feature can add its rows to Security without the core file
 * importing the component and carrying it into every build.
 *
 * The rail lists a category's panels by the same contributions, so `id` is
 * the id of the panel's root element (the rail's `#` target) and `label` is
 * its heading.
 */
export type SettingsPanelContribution = Readonly<{
  id: string;
  label: string;
  category: string;
  Panel: ComponentType;
  order: number;
  /**
   * The panel's own files (ADR 0134), listed under the category its
   * `category` names up to the first dot: a panel drawn inside a
   * Capabilities section (`capabilities.feature-<id>`) lists its files
   * under Capabilities.
   */
  files?: VirtualFileProvider;
}>;

export type CommandPathContribution = Readonly<{ path: string; label: string }>;
export type KeymapJumpContribution = Readonly<{ key: string; path: string }>;

/** The form that creates an item of a contributed kind (a drop's ceremony). */
export type ItemCreateProps = Readonly<{
  initialName?: string;
  initialFolder?: Folder;
  onTypeChange?: (typeId: string, name: string, folder: Folder | null) => void;
}>;

export type ItemKindContribution = Readonly<{
  kind: string;
  label: string;
  segment: string;
  Icon?: ComponentType;
  order: number;
  /**
   * Stored records of this kind still render when this is false, and no
   * creation surface offers the kind.
   */
  creatable?: boolean;
  /** The record view for a stored item of this kind. */
  Record?: ComponentType<{ item: VaultItem }>;
  /** Creating one opens this form in place of the item editor. */
  Create?: ComponentType<ItemCreateProps>;
}>;

/** An offer to share a stored item once, drawn under its fields. */
export type SecretShareContribution = Readonly<{
  id: string;
  order: number;
  Panel: ComponentType<{ item: VaultItem; initialOpen?: boolean }>;
}>;

export type DraftAssistProps = Readonly<{
  typeId: string;
  website?: string;
  onApply: (labels: DraftLabels) => void;
}>;

/** Labels a new item's draft from a model, beside the editor's fields. */
export type DraftAssistContribution = Readonly<{
  id: string;
  order: number;
  Suggestions: ComponentType<DraftAssistProps>;
  /** The same labels for a caller with no editor: the WebMCP draft tools. */
  suggest: (
    context: Readonly<{ typeId: string; website?: string }>,
    signal: AbortSignal,
  ) => Promise<DraftLabels>;
}>;

export type CommandVoiceProps = Readonly<{
  setValue: (text: string) => void;
  setNotice: (text: string | null) => void;
  run: (utterance: string) => Promise<void>;
  busy: boolean;
}>;

/**
 * What the command bar asks when its own parser finds no command: a reading
 * of the utterance, and a voice control. Without one, a sentence the parser
 * cannot place is handed to Support or answered with the parser's hint.
 */
export type CommandAssistContribution = Readonly<{
  id: string;
  order: number;
  interpret: (
    utterance: string,
    options: { itemNames: readonly string[] },
  ) => Promise<InterpretResult>;
  Voice?: ComponentType<CommandVoiceProps>;
}>;

/**
 * A key a capability adds to the vault path strip's command group, after
 * New item: an icon key with its own accessible name, and whatever sheet it
 * opens. Import is one — the capability that reads other managers' files
 * owns the key that picks one (ADR 0130).
 */
export type VaultCommandContribution = Readonly<{
  id: string;
  order: number;
  /** The icon key in a desktop list's path strip. */
  Command: ComponentType;
  /**
   * The same flow as a way to add, for a phone: mounted beside the corner Add
   * button, it registers a menu entry (the long-press and ellipsis menu on that
   * button) and draws its own sheet, and draws nothing else.
   */
  Entry?: ComponentType;
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

/**
 * A component a capability wraps the shell body in — a provider and the one
 * control that opens what it provides. Guided help needs `SupportProvider`
 * and its launcher around the shell; agent tools need their registrar. The
 * core shell knows only "a capability wraps the body", so nothing of either
 * tree is reachable from a build that excluded the capability.
 *
 * Wrappers nest by `order`, lowest outermost, then by `id`, so two
 * capabilities arriving in either sequence produce the same tree.
 *
 * `Gate` is the same capability's part of the screens in front of the shell —
 * the front door, unlock, setup, join, the broker popup and the federation
 * return (ADR 0165). It is drawn *beside* the screen, never around it, so a
 * capability arriving or leaving cannot remount the screen it sits beside; the
 * core owns the seat it draws into and the route the screen declares.
 */
export type ShellWrapperContribution = Readonly<{
  id: string;
  Wrapper: ComponentType<{ children?: ReactNode }>;
  Gate?: ComponentType;
  order: number;
}>;

export type ContributionEntryMap = {
  section: SectionContribution;
  route: RouteContribution;
  "settings-category": SettingsCategoryContribution;
  "settings-panel": SettingsPanelContribution;
  "shell-wrapper": ShellWrapperContribution;
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
  "secret-share": SecretShareContribution;
  "item-draft-assist": DraftAssistContribution;
  "command-assist": CommandAssistContribution;
  "vault-command": VaultCommandContribution;
};

export type ContributionEntry<K extends ContributionKind> =
  ContributionEntryMap[K];

/**
 * Destination-validated fetch. The contract every module codes against;
 * S18's `egress.ts` implements it (adding `capability` and `decide`) against
 * the plan's network envelope and the capability's declared egress classes,
 * and `egress-default.ts` is the same-origin-only stand-in.
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
  egress: import("./egress.js").EgressPort;
  /**
   * The router, for a module whose tools move the person between authored
   * destinations. The loader builds this context before any component has
   * rendered, so it reads the shell's navigate through a seam and throws
   * `router_unavailable` until the shell is mounted (`lib/router-seam.ts`).
   * It used to be an optional port nothing implemented, which is why
   * `opensesame_navigate` answered `router_unavailable` on every call.
   */
  navigate: (to: string) => void;
}>;

export type CapabilityRuntime = Readonly<{
  capability: CapabilityId;
  activate(ctx: ApprovedCapabilityContext): Promise<RuntimeHandle>;
}>;

export type CapabilityModule = Readonly<{
  capabilityRuntime: CapabilityRuntime;
}>;

export type CapabilityDenialCode =
  | "NOT_DISTRIBUTED"
  | "NOT_APPROVED"
  | "STALE_LEASE"
  | "LEASE_UNBOUND"
  | "INVALID_MODULE"
  | "NOT_RESOLVED"
  /** No live registration of the current generation vouches for the call. */
  | "NOT_REGISTERED"
  /** Cross-context admission could not be serialized (no Web Locks). */
  | "NO_SERIALIZATION"
  /** Approved, but it starts only in a fresh document: reload first. */
  | "RELOAD_REQUIRED";

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
export function isCapabilityDenied<Thrown>(
  error: Thrown,
): error is Thrown & CapabilityDenied {
  return error instanceof CapabilityDenied;
}
