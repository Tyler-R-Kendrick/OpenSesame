import type { Provider } from "@opensesame/app-core/lib/connections.js";
import type {
  NativeKeyAction,
  NativeKeyUi,
} from "@opensesame/app-core/lib/native-key-types.js";
import type {
  NativeActionDescriptor,
  NativeConnectorDescriptor,
} from "./native-connector-ui.js";
import { nativePolicyMethod } from "./native-provider-policy.js";

/**
 * A provider that connects from the browser with the person's own key
 * (ADR 0198): the form is whatever the driver says it needs, and the
 * verification is a real call, so nothing here names a provider.
 */
export function nativeKeyDescriptor(
  provider: Provider,
  available: boolean,
  ui: NativeKeyUi,
): NativeConnectorDescriptor {
  return {
    providerId: provider.id,
    name: provider.displayName,
    docsUrl: provider.docsUrl,
    disconnectExplanation: ui.disconnectExplanation,
    methods: [
      // A family whose servers refuse web pages is the bridge's road (ADR 0199).
      nativePolicyMethod(provider.id, {
        id: "api-key",
        label: ui.methodLabel,
        available,
        unavailableReason: `${provider.displayName} signing is unavailable in this browser runtime.`,
        instructions: ui.instructions,
        fields: ui.fields,
        scopeGroups: [],
        links: ui.links,
      }),
    ],
    actions: [],
  };
}

/** What a verified connection can do on a person's request, beyond re-checking access. */
export function nativeKeyActions(
  ui: NativeKeyUi,
): readonly NativeActionDescriptor[] {
  return ui.actions.map((action: NativeKeyAction) => ({
    id: action.id,
    label: action.label,
    available: true,
    fields: action.fields,
    resultOrigins: [],
  }));
}
