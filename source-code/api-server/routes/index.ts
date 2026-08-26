import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import doctrineRouter from "./doctrine";
import gmailAuthRouter from "./gmail-auth";
import emailInspectorRouter from "./email-inspector";
import contextRouter from "./context";
// B7o: admin salvage endpoint for stuck prospects.
import adminSalvageRouter from "./admin-salvage";
// B7s: admin activity rollup (reads followup_usage populated by B7r).
import adminActivityRouter from "./admin-activity";
// B7u: admin activity report (XLSX export).
import adminActivityReportRouter from "./admin-activity-report";
// B7u: admin user controls (pause/resume).
import adminUserControlsRouter from "./admin-user-controls";
// Admin Kill: hard-stop one user's whole follow-up pipeline (transactional).
import adminUserKillRouter from "./admin-user-kill";
// Prospect-level Admin Kill: hard-stop ONE campaign (transactional).
import adminProspectKillRouter from "./admin-prospect-kill";
// Company-level Admin Kill: hard-stop every doctrine campaign at a company.
import adminCompanyKillRouter from "./admin-company-kill";
// Admin global controls (pause-all / resume-all).
import adminGlobalControlsRouter from "./admin-global-controls";
// Admin daily budget cap controls (read spend, set cap, enable/disable).
import adminDailyBudgetRouter from "./admin-daily-budget";
// Admin controls for the Company-Reply Cascade (enable/disable/audit/undo).
import adminCompanyCascadeRouter from "./admin-company-cascade";
// Admin suppression-list controls.
import adminSuppressionRouter from "./admin-suppression";
// F-3.6a: admin read surface over cron_heartbeats — written since Phase 7n,
// readable by nothing until this order. Closes the F-D4 liveness gap.
import adminCronHeartbeatsRouter from "./admin-cron-heartbeats";
// B9b: AntiGhosting Followuper marking flow.
import antiGhostingRouter from "./anti-ghosting";
// F-3.7a: the Chief's uplink — read-only status and accounts, order-token
// gated. Mount order is load-bearing; see the note at the mount below.
import { createChiefRouter, realChiefSources } from "./chief";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(gmailAuthRouter);

// ---------------------------------------------------------------------------
// F-3.7a: THE CHIEF UPLINK, MOUNTED BEFORE `doctrineRouter` ON PURPOSE.
//
// `doctrine.ts` calls `router.use(authMiddleware)` at its top level and is
// mounted below with no path, so the shared `x-api-key` / `ADDON_API_KEY` gate
// applies to every request that reaches that line — which is why each admin
// router underneath it needs two keys. The Chief holds an order-token and
// nothing else and will never send `x-api-key`, so these two routes have to sit
// above that gate to be reachable at all.
//
// Moving this line below `router.use(doctrineRouter)` would not fail a
// typecheck and would not fail any unit test of the handlers themselves; it
// would simply turn every probe into `401 {"error":"Invalid API key"}` and the
// Chief's card into `token rejected`. `test-chief-mount.ts` boots the real app
// and pins it.
// ---------------------------------------------------------------------------
router.use("/chief", createChiefRouter(realChiefSources()));

router.use(doctrineRouter);
router.use(emailInspectorRouter);
// Phase 7b: Context Based Followuper. Mounted under /context so URLs are
// /api/context/stats, /api/context/followups, etc. The doctrine router
// stays at the root (existing UI routes) until 7c adds parallel scoping.
router.use("/context", contextRouter);
// B9b: AntiGhosting Followuper. Mounted under /anti-ghosting so URLs are
// /api/anti-ghosting/mark, /api/anti-ghosting/candidates. Scoped to
// prospects with app='anti_ghosting' via SCOPE constants inside the
// router. The dashboard UI for marking lands in B9b.1; the LLM pipeline
// and scheduler extensions land in B9c.
router.use("/anti-ghosting", antiGhostingRouter);
// B7o: admin endpoints (X-API-Key gated).
router.use(adminSalvageRouter);
// B7s: mount admin activity router (X-API-Key gated).
router.use(adminActivityRouter);
// B7u: mount admin activity report + user controls (X-API-Key gated).
router.use(adminActivityReportRouter);
router.use(adminUserControlsRouter);
// Admin Kill (X-API-Key gated): POST /api/admin/users/:id/kill.
router.use(adminUserKillRouter);
// Prospect-level Admin Kill (X-API-Key gated): POST /api/admin/prospects/:id/kill.
router.use(adminProspectKillRouter);
// Company-level Admin Kill (admin-key gated): POST /api/admin/company/kill.
router.use(adminCompanyKillRouter);
router.use(adminGlobalControlsRouter);
router.use(adminDailyBudgetRouter);
router.use(adminCompanyCascadeRouter);
router.use(adminSuppressionRouter);
router.use(adminCronHeartbeatsRouter);

export default router;