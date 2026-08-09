import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * A production bundle must not carry the operator token.
 *
 * `VITE_*` variables are inlined into the shipped JavaScript, so a build that sets
 * this one publishes a machine-local shared secret to everyone who loads the page.
 * Keeping it out was a deployment convention; this makes the build refuse.
 */
function assertNoBakedOperatorToken(mode: string, env: Record<string, string>) {
  if (mode !== "production") return;
  if ((env.VITE_OPENSESAME_OPERATOR_TOKEN ?? "").trim() === "") return;
  throw new Error(
    "VITE_OPENSESAME_OPERATOR_TOKEN must not be set for a production build: it would be inlined into the bundle. Use it only for a local dev build against a loopback gateway.",
  );
}

export default defineConfig(({ mode }) => {
  assertNoBakedOperatorToken(mode, loadEnv(mode, process.cwd(), "VITE_"));
  return {
    build: {
      // esbuild 0.28 cannot downlevel some destructuring forms to Vite's default
      // legacy browser set (see apps/pages); the console targets modern browsers.
      target: ["es2022", "chrome100", "firefox100", "safari15"],
    },
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
    },
  };
});
