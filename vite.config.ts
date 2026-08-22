import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        client: resolve(__dirname, "index.html"),
        coach: resolve(__dirname, "coach/index.html")
      }
    }
  },
  server: { port: 5173 }
});
