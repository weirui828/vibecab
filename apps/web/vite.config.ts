import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname),
  base: "/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../../dist/apps/web/client", emptyOutDir: true, chunkSizeWarningLimit: 5000 },
});
