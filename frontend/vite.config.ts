import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin API in development, matching the production rewrite of /api to FastAPI.
    proxy: { "/api": { target: "http://127.0.0.1:8000" } },
  },
});
