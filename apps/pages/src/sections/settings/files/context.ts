/**
 * The Form view reaches the file behind what it shows: any row may open its
 * file in Settings' file viewer. SettingsSection provides this; a panel drawn
 * outside it (a test, a sheet) gets null and draws no open key.
 */
import { createContext, useContext } from "react";

export type SettingsFileNav = { readonly openFile: (path: string) => void };

export const SettingsFileContext = createContext<SettingsFileNav | null>(null);

export function useOpenSettingsFile(): ((path: string) => void) | null {
  return useContext(SettingsFileContext)?.openFile ?? null;
}
