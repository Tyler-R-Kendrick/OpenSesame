import type {
  BrowserUnavailableKind,
  DispositionRoute,
} from "@opensesame/app-core/lib/browser-disposition.js";
import type { NativeConfigurationOwner } from "@opensesame/app-core/lib/native-connector-drivers.js";
import type { NativeMethod } from "@opensesame/app-core/lib/native-connector-schema.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import type { ConfigChoice } from "@opensesame/app-core/lib/self-hosted-config.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";

export type NativeFieldValues = Record<string, string>;

export type NativeField = {
  id: string;
  label: string;
  kind: "text" | "url" | "choice" | "textarea";
  secret: boolean;
  required: boolean;
  placeholder?: string;
  maxLength?: number;
  help?: string;
  defaultValue?: string;
  readOnly?: boolean;
  displayOnly?: boolean;
  choices?: readonly { id: string; label: string }[];
  when?: { fieldId: string; value: string };
};

export type NativeScopeGroup = {
  actor: string;
  label: string;
  help?: string;
  choices: readonly ConfigChoice[];
  requiredScopes?: readonly string[];
};

export type NativeMethodDescriptor = {
  id: NativeMethod;
  label: string;
  available: boolean;
  /** Compiled editor remains reachable before transport admission; never authorizes Connect. */
  configurable?: boolean;
  /** Original executable method gate before browser-origin policy; editing cannot enable it. */
  runtimeAvailable?: boolean;
  unavailableReason?: string;
  /** Why it is unavailable, as a closed reason a tile can name (never prose). */
  unavailableKind?: BrowserUnavailableKind;
  instructions?: string;
  fields: readonly NativeField[];
  scopeGroups: readonly NativeScopeGroup[];
  authorizeFirst?: boolean;
  authorizationActor?: string;
  /** Lower ranks are the simplest secure route; absent keeps the legacy order. */
  preferredRank?: number;
  links?: readonly { label: string; url: string }[];
};

export type NativeActionDescriptor = {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  inputSchema?: string;
  fields: readonly NativeField[];
  resultOrigins: readonly string[];
};

/** Compiled provider facts and actual controller availability, never tokens. */
export type NativeConnectorDescriptor = {
  providerId: string;
  name: string;
  docsUrl: string | null;
  methods: readonly NativeMethodDescriptor[];
  actions: readonly NativeActionDescriptor[];
  disconnectExplanation?: string;
  /** Other places a person is sent, each named for what it is (never "<Name> documentation" for a page that is not). */
  externalLinks?: readonly { label: string; url: string }[];
  configurationLinks?: readonly {
    label: string;
    to: DispositionRoute | "/setup/connectors";
  }[];
};

export type NativeConfigureInput = {
  owner?: NativeConfigurationOwner;
  method: NativeMethod;
  displayName: string;
  icon?: string;
  parameters: Record<string, string>;
  credentials: Record<string, string>;
  requestedScopes: Record<string, string[]>;
  targetIds: Record<string, string>;
};

export type SafeActionResult = {
  label: string;
  items: readonly {
    id: string;
    label: string;
    url?: string;
    inputSchema?: string;
    secretValue?: string;
  }[];
};

export type NativeRevocationGuide = {
  url: string;
  message: string;
  canConfirm: boolean;
  acknowledgementLabel?: string;
  revision?: number;
};

/** The owner pins these operations to one provider and configuration revision. */
export type NativeConnectorController = {
  cancelAuthorization: () => void;
  load: () => NativeConnectorView | null;
  configure: (input: NativeConfigureInput) => Promise<NativeConnectorView>;
  /** Prove the credentials against the provider without saving anything. */
  test?: (input: NativeConfigureInput) => Promise<{ label: string }>;
  connect: (input: NativeConfigureInput) => Promise<NativeConnectorView>;
  authorize: (actor?: string) => Promise<void>;
  verify: () => Promise<NativeConnectorView>;
  invoke: (
    operationId: string,
    input: Record<string, string>,
    signal?: AbortSignal,
  ) => Promise<SafeActionResult>;
  retry: (recoveryId: string) => Promise<NativeConnectorView>;
  revocationInstructions?: (recoveryId: string) => NativeRevocationGuide | null;
  loadRevocationInstructions?: (
    recoveryId: string,
  ) => Promise<NativeRevocationGuide | null>;
  confirmRevocation?: (
    recoveryId: string,
    guideRevision?: number,
  ) => Promise<NativeConnectorView>;
  remove: () => Promise<void>;
};

export type NativeConnectorCallbacks = {
  onChanged: (view: NativeConnectorView | null) => void;
  onFlash: (flash: Flash) => void;
};

/** Editing public configuration is separate from authorizing a provider operation. */
export function nativeMethodConfigurable(
  method: Pick<
    NativeMethodDescriptor,
    "available" | "configurable" | "unavailableKind"
  >,
): boolean {
  return (
    method.unavailableKind !== "policy" &&
    (method.available || method.configurable === true)
  );
}
