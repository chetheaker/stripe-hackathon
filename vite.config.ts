import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// web/index.html is the order screen (React). Che's plain kiosk lives at /basic/.
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:3000", ws: true },
      "/api": "http://localhost:3000",
    },
  },
});
