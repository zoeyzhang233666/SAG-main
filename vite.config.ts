import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4300",
      "/health": "http://127.0.0.1:4300",
      "/share-login": "http://127.0.0.1:4300",
      "/sources": "http://127.0.0.1:4300",
      "/ingest": "http://127.0.0.1:4300",
      "/search": "http://127.0.0.1:4300",
      "/events": "http://127.0.0.1:4300"
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
