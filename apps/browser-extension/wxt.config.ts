import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "OpenSesame",
    description:
      "Private authorization fabric — Host API health and sealed sync, never raw secrets",
    permissions: ["storage", "alarms"],
    host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
