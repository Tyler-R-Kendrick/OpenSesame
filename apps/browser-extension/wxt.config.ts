import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "OpenSesame",
    description: "Private authorization fabric — typed broker requests, not raw secrets",
    permissions: ["storage", "alarms"],
    host_permissions: [],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'"
    }
  }
});
