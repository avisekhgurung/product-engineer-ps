import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server proxies /api to the Go service, so the browser talks to one
// origin and EventSource needs no CORS handling during development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
