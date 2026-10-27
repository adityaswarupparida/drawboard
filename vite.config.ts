import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Workers AI only runs remotely, so dev needs `wrangler login`. OFFLINE=1 skips that; AI features then fail.
const offline = !!process.env.OFFLINE;

export default defineConfig({
  plugins: [react(), cloudflare({ remoteBindings: !offline })],
});
