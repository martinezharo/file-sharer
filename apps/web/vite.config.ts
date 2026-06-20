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
      includeAssets: ["icon.svg", "icon-maskable.svg"],
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
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
        ],
      },
      workbox: {
        // Never let the service worker serve the API from cache.
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // In dev, forward API calls to the local Worker (wrangler dev).
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
