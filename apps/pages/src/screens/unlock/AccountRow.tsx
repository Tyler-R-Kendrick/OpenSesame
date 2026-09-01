/**
 * Who this device is signed in as, above both unlock tabs.
 *
 * The account is a fact about the device, not about the vault: a Google
 * account signed in through shoo.dev is still signed in while the vault is
 * locked, and until now the only place that said so — or offered a way out
 * of it — was a link on the Sign in tab. This row names the person (never a
 * raw subject), the way in, and the two roads out: switch, which ends the
 * session and arms a fresh sign-in, and sign out. Absent entirely when
 * nobody is signed in.
 */

import { IconUser } from "../../components/Icons.js";
import { useAccount } from "../../lib/account.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { brandFor } from "./ProviderBrand.js";

type Props = {
  disabled?: boolean;
  onSwitch: () => void;
  onSignOut: () => void;
};

export function AccountRow({ disabled, onSwitch, onSignOut }: Props) {
  const account = useAccount();
  const ref = useGuideTarget<HTMLDivElement>("unlock.account");
  if (!account) return null;
  const brand = account.providerId ? brandFor(account.providerId) : null;
  return (
    <div className="who" ref={ref} data-testid="account-row">
      <span className="who__mark" aria-hidden="true">
        {brand ? <brand.Icon size={16} /> : <IconUser size={16} />}
      </span>
      <span className="who__body">
        <span className="who__name">{account.name}</span>
        <span className="who__sub">{account.detail}</span>
      </span>
      <span className="who__acts">
        <button
          type="button"
          className="unlock__switch"
          disabled={disabled}
          onClick={onSwitch}
        >
          Switch
        </button>
        <button
          type="button"
          className="unlock__switch"
          disabled={disabled}
          onClick={onSignOut}
        >
          Sign out
        </button>
      </span>
    </div>
  );
}
