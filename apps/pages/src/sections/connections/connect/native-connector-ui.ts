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
  unavailableReason?: string;
  instructions?: string;
  fields: readonly NativeField[];
  scopeGroups: readonly NativeScopeGroup[];
  authorizeFirst?: boolean;
  authorizationActor?: string;
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
  configurationLinks?: readonly {
    label: string;
    to: "/vault?f=all" | "/setup/connectors";
  }[];
};

export type NativeConfigureInput = {
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

/** The owner pins these operations to one provider and configuration revision. */
export type NativeConnectorController = {
  cancelAuthorization: () => void;
  load: () => NativeConnectorView | null;
  configure: (input: NativeConfigureInput) => Promise<NativeConnectorView>;
  connect: (input: NativeConfigureInput) => Promise<NativeConnectorView>;
  authorize: (actor?: string) => Promise<void>;
  verify: () => Promise<NativeConnectorView>;
  invoke: (
    operationId: string,
    input: Record<string, string>,
  ) => Promise<SafeActionResult>;
  retry: (recoveryId: string) => Promise<NativeConnectorView>;
  revocationInstructions?: (recoveryId: string) => {
    url: string;
    message: string;
    canConfirm: boolean;
    acknowledgementLabel?: string;
  } | null;
  confirmRevocation?: (recoveryId: string) => Promise<NativeConnectorView>;
  remove: () => Promise<void>;
};

export type NativeConnectorCallbacks = {
  onChanged: (view: NativeConnectorView | null) => void;
  onFlash: (flash: Flash) => void;
};
