import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
// B9d.7: page transition animations via AnimatePresence keyed on location.
// B9d.7.1: useReducedMotion gates animations on OS prefers-reduced-motion.
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiKeyContextProvider } from "@/hooks/use-api-key";
import { CurrentUserProvider } from "@/hooks/use-current-user";
import { ApiKeyGate } from "@/components/api-key-provider";
import { Layout } from "@/components/layout";

import Pipeline from "@/pages/pipeline";
import EmailInspector from "@/pages/email-inspector";
import Accounts from "@/pages/accounts";
import ActivityLog from "@/pages/activity-log";
// B7t: admin activity dashboard (per-LLM-call usage ledger).
import AdminActivity from "@/pages/admin-activity";
import NotFound from "@/pages/not-found";

// Phase 7d: Context Based Followuper UI scaffolding.
import Picker from "@/pages/picker";
import ContextPipeline from "@/pages/context-pipeline";
import ContextEmailInspector from "@/pages/context-inspector";
import ContextActivityLog from "@/pages/context-activity";
// B9b.1: AntiGhosting Followuper page (third product alongside
// Doctrine and Context). Mark Gmail threads tagged with the
// AntiGhosting label for re-engagement.
import AntiGhosting from "@/pages/anti-ghosting";
// B9b.8: AntiGhosting Pipeline page (view-only listing of the
// anti_ghosting prospects in flight; actions ship in later batches).
import AntiGhostingPipeline from "@/pages/anti-ghosting-pipeline";
// B9b.12: AntiGhosting Email Inspector page.
import AntiGhostingEmailInspector from "@/pages/anti-ghosting-inspector";
// AntiGhosting Activity Log page (per-user operational rollup, mirrors
// the Context Activity Log scoped to app='anti_ghosting').
import AntiGhostingActivityLog from "@/pages/anti-ghosting-activity";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function Router() {
  // B9d.7: AnimatePresence wraps Switch so route changes animate as a fade+slide.
  // mode="wait" ensures the old page exits before the new one mounts.
  // B9d.7.1: motion props gated on prefers-reduced-motion. Users with that OS
  // preference get a static wrapper (no entrance/exit animation, no slide).
  const [location] = useLocation();
  const reduceMotion = useReducedMotion();
  // B9d.8: variants pattern with staggerChildren orchestrates cascade.
  // when: "beforeChildren" runs page fade-in first, then cascades cards
  // via the same hidden/visible state names (Card uses matching variants).
  const pageVariants = {
    hidden: { opacity: 0, y: 8 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.2,
        ease: "easeOut" as const,
        when: "beforeChildren" as const,
        staggerChildren: 0, // B10.7: cascade removed - cards animate together.
      },
    },
    exit: { opacity: 0, y: -8, transition: { duration: 0.2 } },
  };
  const motionProps = reduceMotion ? {} : {
    initial: "hidden" as const,
    animate: "visible" as const,
    exit: "exit" as const,
    variants: pageVariants,
  };
  return (
    <AnimatePresence mode="wait">
      <motion.div key={location} {...motionProps}>
        <Switch>
      <Route path="/" component={Pipeline} />
      <Route path="/pipeline" component={Pipeline} />
      {/* Legacy routes redirect to Pipeline (prospects.tsx + followups.tsx
          were removed in Phase 3c). Kept here as path matchers so old
          bookmarks / inbound links still resolve. */}
      <Route path="/prospects" component={Pipeline} />
      <Route path="/followups" component={Pipeline} />
      <Route path="/inspector" component={EmailInspector} />
      <Route path="/accounts" component={Accounts} />
      <Route path="/activity" component={ActivityLog} />
      {/* B7t: route admin-activity — per-LLM-call cost & token ledger.
          Render-prop form because AdminActivity now takes an optional
          lockedApp prop, which is not assignable to wouter's component=. */}
      <Route path="/admin-activity">{() => <AdminActivity />}</Route>
      {/* Phase 7d: picker + context routes. Doctrine routes above are unchanged. */}
      <Route path="/picker" component={Picker} />
      <Route path="/context/pipeline" component={ContextPipeline} />
      <Route path="/context/inspector" component={ContextEmailInspector} />
      <Route path="/context/activity" component={ContextActivityLog} />
      {/* B9b.1: AntiGhosting Followuper route. */}
      <Route path="/anti-ghosting" component={AntiGhosting} />
      {/* B9b.8: AntiGhosting Pipeline route. */}
      <Route path="/anti-ghosting/pipeline" component={AntiGhostingPipeline} />
      {/* B9b.12: AntiGhosting Email Inspector route. */}
      <Route path="/anti-ghosting/inspector" component={AntiGhostingEmailInspector} />
      {/* AntiGhosting Activity Log (operational per-user rollup). */}
      <Route path="/anti-ghosting/activity" component={AntiGhostingActivityLog} />
      {/* AntiGhosting Admin Activity — shared cost ledger locked to app='anti_ghosting'. */}
      <Route path="/anti-ghosting/admin-activity">{() => <AdminActivity lockedApp="anti_ghosting" />}</Route>
      <Route component={NotFound} />
    </Switch>
      </motion.div>
    </AnimatePresence>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <CurrentUserProvider>
      <ApiKeyContextProvider>
        <ApiKeyGate>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Layout>
              <Router />
            </Layout>
          </WouterRouter>
        </ApiKeyGate>
      </ApiKeyContextProvider>
      </CurrentUserProvider>
    </QueryClientProvider>
  );
}

export default App;