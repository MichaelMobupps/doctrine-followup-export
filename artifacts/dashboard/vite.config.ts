import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const isBuild = process.argv.includes("build");
const rawPort = process.env.PORT;

if (!rawPort && !isBuild) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = rawPort ? Number(rawPort) : 3000;

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Bundle 2: Vite requires `base` to end with "/", and every client call site
// appends WITHOUT a leading slash (`${BASE_PATH}api/stats`). Normalize both
// accepted spellings — "/followup" and "/followup/" — to the trailing-slash
// form so the two conventions cannot drift. "/" is unchanged, so an unset
// BASE_PATH produces exactly the base this config produced before.
//
// C1: BASE_PATH now flows in from the deployment environment (the artifact's
// `[services.env]` no longer pins it), so validate it here the way the server
// already validates it in api-server/src/lib/appUrls.ts. Without this, a base
// of "//evil.example/" is stamped verbatim and every asset tag becomes
// `src="//evil.example/assets/..."` — a protocol-relative URL the browser
// resolves against a FOREIGN host. Same rule set as normalizeBasePath: must be
// a plain rooted path, no leading "//", no backslash (the WHATWG URL parser
// reads "/\" as "//"), no control characters. Anything else falls back to "/",
// which is also the unset default — so a rejected value degrades to exactly
// the rolled-back state rather than failing the build.
function normalizeBase(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "/";
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return "/";
  if (trimmed.includes("\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "/";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

const basePath = normalizeBase(process.env.BASE_PATH);

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
