import { createRoot as createRootImpl } from "react-dom/client";

export const reactDomSeams = {
  createRoot: createRootImpl,
};

export function createRoot(
  ...args: Parameters<typeof createRootImpl>
): ReturnType<typeof createRootImpl> {
  return reactDomSeams.createRoot(...args);
}
