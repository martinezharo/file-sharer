import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

function cliValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("-") ? value : undefined;
}

// `pnpm dev --host <ip>` forwards the host to Vite and Wrangler. Keep the API
// proxy on the same interface so a remote VPS development session does not
// accidentally point at the browser's own localhost.
const requestedHost = process.env.FILE_SHARER_DEV_HOST ?? cliValue("--host");
const remoteHost =
  requestedHost && !["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(requestedHost)
    ? requestedHost
    : undefined;
const workerTarget =
  process.env.FILE_SHARER_WORKER_URL ??
  (remoteHost ? `http://${remoteHost}:8787` : "http://localhost:8787");

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [
    tailwindcss(),
    preact(),
    ...(isSsrBuild
      ? []
      : [
          VitePWA({
            registerType: "autoUpdate",
            // We register the service worker ourselves in main.tsx (bundled, so the
            // strict `script-src 'self'` CSP holds) to add periodic/focus update checks.
            injectRegister: false,
            // Custom SW (src/sw.ts): precache + root app-shell fallback, plus the
            // Web Share Target handler and Background Sync outbox flushing.
            strategies: "injectManifest",
            srcDir: "src",
            filename: "sw.ts",
            injectManifest: {
              globPatterns: ["**/*.{js,css,html,svg,woff2}"],
            },
            includeAssets: [
              "favicon.svg",
              "icon-maskable.svg",
              "icon-192.png",
              "icon-512.png",
              "icon-maskable-192.png",
              "icon-maskable-512.png",
              "og.png",
            ],
            manifest: {
              name: "file-sharer",
              short_name: "file-sharer",
              description: "Private, end-to-end encrypted text & file sharing between your devices",
              lang: "en",
              theme_color: "#5b5bd6",
              background_color: "#f6f6f7",
              display: "standalone",
              // The app opens on the spaces of this device, not the marketing
              // page: an installed PWA has already been "landed on".
              start_url: "/app",
              scope: "/",
              id: "/",
              icons: [
                // Raster PNGs first: Android needs these to mint a WebAPK (required for
                // the Web Share Target to register with the OS share sheet).
                { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
                { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
                {
                  src: "/icon-maskable-192.png",
                  sizes: "192x192",
                  type: "image/png",
                  purpose: "maskable",
                },
                {
                  src: "/icon-maskable-512.png",
                  sizes: "512x512",
                  type: "image/png",
                  purpose: "maskable",
                },
                { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
                {
                  src: "/icon-maskable.svg",
                  sizes: "any",
                  type: "image/svg+xml",
                  purpose: "maskable",
                },
              ],
              // Let the OS share sheet send text & files to this installed PWA. The
              // POST is intercepted by the service worker (src/sw/share-target.ts).
              share_target: {
                action: "/share-target",
                method: "POST",
                enctype: "multipart/form-data",
                params: {
                  title: "title",
                  text: "text",
                  url: "url",
                  files: [{ name: "files", accept: ["*/*"] }],
                },
              },
            },
            devOptions: { enabled: false },
          }),
        ]),
  ],
  build: {
    // Avoid Vite's inline module-preload polyfill so the built index.html has no
    // inline <script> (keeps the strict `script-src 'self'` CSP working).
    modulePreload: { polyfill: false },
  },
  server: {
    port: 5173,
    ...(remoteHost ? { allowedHosts: [remoteHost, ".ts.net"] } : {}),
    proxy: {
      // In dev, forward API calls to the local Worker (wrangler dev).
      "/api": { target: workerTarget, changeOrigin: true },
    },
  },
}));
