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
// Admin global controls (pause-all / resume-all).
import adminGlobalControlsRouter from "./admin-global-controls";
// Admin suppression-list controls.
import adminSuppressionRouter from "./admin-suppression";
// B9b: AntiGhosting Followuper marking flow.
import antiGhostingRouter from "./anti-ghosting";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(gmailAuthRouter);
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
router.use(adminGlobalControlsRouter);
router.use(adminSuppressionRouter);

export default router;