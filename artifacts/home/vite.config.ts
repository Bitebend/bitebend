import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

function netlifyRedirectsPlugin() {
  return {
    name: "netlify-redirects-copy",
    closeBundle() {
      const src = path.resolve(import.meta.dirname, "public/_redirects");
      const destDir = path.resolve(import.meta.dirname, "dist");
      const dest = path.join(destDir, "_redirects");

      try {
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true });
        }
        if (existsSync(src)) {
          copyFileSync(src, dest);
          console.log("\n[_redirects] copied to dist successfully\n");
        }
      } catch (err) {
        console.error("[_redirects] copy failed:", err);
      }
    },
  };
}

const rawPort = process.env.PORT;
const port = rawPort ? Number(rawPort) : 5174;

export default defineConfig({
  base: "/",

  plugins: [
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

  root: path.resolve(import.meta.dirname),

  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },

  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },

  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
