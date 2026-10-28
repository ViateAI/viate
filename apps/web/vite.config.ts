import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function portalDevServer(): Plugin {
  return {
    name: "viate-portal",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "/";
        const queryIndex = url.indexOf("?");
        const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
        const query = queryIndex === -1 ? "" : url.slice(queryIndex);
        if (path === "/") {
          res.statusCode = 302;
          res.setHeader("location", `/portal${query}`);
          res.end();
          return;
        }
        if (path === "/portal" || path.startsWith("/portal/")) {
          req.url = `/admin/${query}`;
          next();
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [portalDevServer(), react()],
  base: "/admin/",
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:4317", changeOrigin: false },
      "/health": { target: "http://127.0.0.1:4317", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
