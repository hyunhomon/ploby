import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// The Ploby server (escrow/server.py) serves its routes under /api itself, so the proxy
// forwards the path unchanged.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3010",
      },
    },
  },
})
