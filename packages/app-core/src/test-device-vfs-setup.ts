/** Install transparent device routing before later setup imports can load VFS. */
import { expect } from "vitest";
import { installDeviceVfsNamespaces } from "./lib/__tests__/vfs-device-namespaces.js";

installDeviceVfsNamespaces(expect.getState().testPath);
