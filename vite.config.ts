import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Workers AI always runs on Cloudflare, so local dev needs `wrangler login`.
// Set OFFLINE=1 to run without it (AI chat, voice and reviews will fail, everything else works).
const offline = !!process.env.OFFLINE;

export default defineConfig({
  plugins: [react(), cloudflare({ remoteBindings: !offline })],
});
