import type { Ref } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconSettings } from "../../components/Icons.js";

export function SignInConfigurationNote({
  shown,
  keyRef,
  onConfigure,
}: {
  shown: boolean;
  keyRef: Ref<HTMLButtonElement>;
  onConfigure: () => void;
}) {
  if (!shown) return null;
  return (
    <div className="note unlock__unset">
      <span>
        No way in is configured for this deployment yet, so sign-in has nowhere
        to go.
      </span>
      <IconKey label="Set it up" small keyRef={keyRef} onClick={onConfigure}>
        <IconSettings size={16} />
      </IconKey>
    </div>
  );
}
