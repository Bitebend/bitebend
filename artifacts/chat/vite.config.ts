import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import path from "node:path";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

function netlifyRedirectsPlugin() {
  return {
    name: "netlify-redirects-copy",
    closeBundle() {
      const src = path.resolve(import.meta.dirname, "public/_redirects");
      const destDir = path.resolve(import.meta.dirname, "dist");
      const dest = path.join(destDir, "_redirects");
      try {
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
        if (existsSync(src)) copyFileSync(src, dest);
      } catch (err) {
        console.error("[_redirects] copy failed:", err);
      }
    },
  };
}

const rawPort = process.env["PORT"];
const port = rawPort ? Number(rawPort) : 5175;
const chatApiTarget = process.env["CHAT_API_TARGET_URL"] || "http://localhost:3002";

export default defineConfig({
  base: "/",

  plugins: [
    wasm(),
    react(),
    tailwindcss(),
    netlifyRedirectsPlugin(),
  ],

  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },

  optimizeDeps: {
    exclude: ["@matrix-org/matrix-sdk-crypto-wasm"],
  },

  root: path.resolve(import.meta.dirname),

  build: {
    target: "es2022",
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },

  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api/chat/ws": {
        target: chatApiTarget,
        changeOrigin: true,
        ws: true,
        xfwd: true,
      },
      "/api": {
        target: chatApiTarget,
        changeOrigin: true,
        xfwd: true,
      },
    },
  },

  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api/chat/ws": {
        target: chatApiTarget,
        changeOrigin: true,
        ws: true,
        xfwd: true,
      },
      "/api": {
        target: chatApiTarget,
        changeOrigin: true,
        xfwd: true,
      },
    },
  },
});
