import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/auth": "http://127.0.0.1:3000",
      "/setup": "http://127.0.0.1:3000",
      "/device-state": "http://127.0.0.1:3000",
      "/projects": "http://127.0.0.1:3000",
      "/sessions": "http://127.0.0.1:3000",
      "/events": "http://127.0.0.1:3000",
      "/system-events": "http://127.0.0.1:3000",
      "/permission-requests": "http://127.0.0.1:3000",
      "/extensions": "http://127.0.0.1:3000",
      "/mcp": "http://127.0.0.1:3000",
      "/skills": "http://127.0.0.1:3000",
      "/skill-sources": "http://127.0.0.1:3000",
      "/skill-events": "http://127.0.0.1:3000",
      "/webridge": "http://127.0.0.1:3000",
      "/diagnostics": "http://127.0.0.1:3000",
      "/artifacts": "http://127.0.0.1:3000",
      "/files": "http://127.0.0.1:3000",
      "/network-urls": "http://127.0.0.1:3000",
      "/identity": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
      "/discovery": "http://127.0.0.1:3000",
    },
  },
});
