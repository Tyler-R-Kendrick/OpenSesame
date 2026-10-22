/**
 * The PWA Web App Manifest. Kept out of `vite.config.ts` so the build config
 * stays under the structural line budget and the install surface is reviewable
 * on its own.
 */
export const pwaManifest = {
  id: "./",
  name: "OpenSesame",
  short_name: "OpenSesame",
  description:
    "End-to-end-encrypted vault for passwords, passkeys, and agent secrets",
  lang: "en",
  dir: "ltr",
  categories: ["productivity", "security", "utilities"],
  theme_color: "#fafafa",
  background_color: "#fafafa",
  display: "standalone",
  display_override: ["standalone", "minimal-ui"],
  launch_handler: { client_mode: "navigate-existing" },
  handle_links: "preferred",
  start_url: "./",
  scope: "./",
  prefer_related_applications: false,
  icons: [
    {
      src: "icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
    {
      src: "icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    },
  ],
  shortcuts: [
    { name: "Vault", short_name: "Vault", url: "./" },
    { name: "Access", short_name: "Access", url: "./access" },
    { name: "Identity", short_name: "Identity", url: "./identity" },
    { name: "Wallet", short_name: "Wallet", url: "./wallet" },
    { name: "Settings", short_name: "Settings", url: "./settings" },
  ],
  // A file opened from the OS is held for the existing Import review; the
  // handler never writes a vault item. Keep the list to formats the import
  // pipeline actually recognises.
  file_handlers: [
    {
      action: "./",
      accept: {
        "application/x-keepass2": [".kdbx", ".kdb"],
        "application/json": [".json"],
        "application/zip": [".1pux", ".zip"],
        "text/csv": [".csv"],
        "text/plain": [".env"],
      },
    },
  ],
  // The worker bounds and stages the POST, then redirects into review. Text
  // and one file are accepted; a second file is refused rather than silently
  // dropped.
  share_target: {
    action: "./share-target",
    method: "POST",
    enctype: "multipart/form-data",
    params: {
      title: "title",
      text: "text",
      url: "url",
      files: [
        {
          name: "files",
          accept: [
            "application/x-keepass2",
            "application/json",
            "application/zip",
            "text/csv",
            "text/plain",
          ],
        },
      ],
    },
  },
};
