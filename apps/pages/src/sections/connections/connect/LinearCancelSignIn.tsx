import { optionalNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconX } from "../../../components/Icons.js";

export function LinearCancelSignIn({ authorizing }: { authorizing: boolean }) {
  const cancel = optionalNativeOAuthBrowserPort()?.cancelAuthorization;
  if (!authorizing || !cancel) return null;
  return (
    <div className="cx-links">
      <IconKey label="Cancel sign-in" onClick={cancel}>
        <IconX size={16} />
      </IconKey>
    </div>
  );
}
