/**
 * The seat beside the vault's name in the shell prompt, next to the lock:
 * where the live-sessions capability puts its Share key while it is on.
 *
 * The shell knows only the seat. The capability's shell wrapper provides
 * the key and the sheet behind it (`VaultShareProvider`), so a build or
 * plan without live sessions draws nothing here — the same arrangement as
 * the support mark's statusline seat, except the seat renders the provided
 * component where it stands: the prompt is drawn twice (rail and drawer),
 * like the lock, and each drawing carries its own key into the one sheet.
 *
 * The rail's context menu opens the same sheet without standing in React,
 * so the provider also mirrors its value where `vaultShareSnapshot` reads
 * it, the way contributions are read there.
 */

import {
  type ComponentType,
  type ReactElement,
  type ReactNode,
  createContext,
  useContext,
  useEffect,
} from "react";

export type VaultShare = Readonly<{
  /** The key itself, drawn in the seat. It opens through `open`. */
  Button: ComponentType;
  /** Open the share sheet: start a session, or see the one running. */
  open: () => void;
}>;

const VaultShareContext = createContext<VaultShare | null>(null);

let current: VaultShare | null = null;

/** The share the live capability has put in the seat, if it is on. */
export function vaultShareSnapshot(): VaultShare | null {
  return current;
}

export function VaultShareProvider({
  value,
  children,
}: {
  value: VaultShare;
  children?: ReactNode;
}): ReactElement {
  useEffect(() => {
    current = value;
    return () => {
      if (current === value) current = null;
    };
  }, [value]);
  return (
    <VaultShareContext.Provider value={value}>
      {children}
    </VaultShareContext.Provider>
  );
}

/** The provided share, for the key the seat draws. */
export function useVaultShare(): VaultShare | null {
  return useContext(VaultShareContext);
}

/** Empty while live sessions is off; the Share key while it is on. */
export function VaultShareSeat(): ReactElement | null {
  const share = useVaultShare();
  if (!share) return null;
  const { Button } = share;
  return <Button />;
}
