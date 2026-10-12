import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconX } from "../../../components/Icons.js";
import { nativeSignInRequired } from "./NativeConnectorFormOptions.js";
import type { NativeMethodDescriptor } from "./native-connector-ui.js";

/** COOP isolates the provider window; cancellation belongs to the originating session. */
export function NativeCancelSignIn({
  busy,
  method,
  view,
  onCancel,
}: {
  busy: boolean;
  method?: NativeMethodDescriptor;
  view?: NativeConnectorView | null;
  onCancel: () => void;
}) {
  if (!busy || !method || !nativeSignInRequired(method, view)) return null;
  return (
    <div className="cx-links">
      <IconKey label="Cancel sign-in" onClick={onCancel}>
        <IconX size={16} />
      </IconKey>
    </div>
  );
}
