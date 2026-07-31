import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import { ROUTER_BASE } from "./lib/app-urls";
import "./index.css";

// Bundle 2: teach the generated API client about the mount prefix.
//
// The Orval-generated hooks emit rooted paths ("/api/stats", …) and must not
// be hand-edited, but custom-fetch already ships a runtime setter: it prepends
// the base URL to any request whose path starts with "/". This one call is
// what makes those hooks prefix-aware.
//
// ROUTER_BASE is "" when BASE_PATH is unset, and setBaseUrl("") stores null —
// the exact state the module already holds by default — so with no env var set
// the client behaves as it did before this bundle.
setBaseUrl(ROUTER_BASE);

createRoot(document.getElementById("root")!).render(<App />);
