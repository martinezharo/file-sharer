import tailwindcss from "@tailwindcss/vite";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    tailwindcss(),
    preact(),
    VitePWA({
      registerType: "autoUpdate",
      // We register the service worker ourselves in main.tsx (bundled, so the
      // strict `script-src 'self'` CSP holds) to add periodic/focus update checks.
      injectRegister: false,
      // Custom SW (src/sw.ts): precache + SPA fallback like generateSW did,
      // plus the Web Share Target handler and Background Sync outbox flushing
      // (uploads finish even after the app is closed).
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
      },
      includeAssets: [
        "icon.svg",
        "icon-maskable.svg",
        "icon-192.png",
        "icon-512.png",
        "icon-maskable-192.png",
        "icon-maskable-512.png",
      ],
      manifest: {
        name: "file-sharer",
        short_name: "file-sharer",
        description: "Private, end-to-end encrypted text & file sharing between your devices",
        lang: "en",
        theme_color: "#5b5bd6",
        background_color: "#f6f6f7",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          // Raster PNGs first: Android needs these to mint a WebAPK (required for
          // the Web Share Target to register with the OS share sheet).
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
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
  ],
  build: {
    // Avoid Vite's inline module-preload polyfill so the built index.html has no
    // inline <script> (keeps the strict `script-src 'self'` CSP working).
    modulePreload: { polyfill: false },
  },
  server: {
    port: 5173,
    proxy: {
      // In dev, forward API calls to the local Worker (wrangler dev).
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
