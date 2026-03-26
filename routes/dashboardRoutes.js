import express from "express";
import { getDashboardStats } from "../controllers/dashboardController.js";
import { authAdmin } from "../middleware/authAdmin.js";

const router = express.Router();

// GET /api/dashboard/stats?filter=today|yesterday|date|range&date=...&from=...&to=...
router.get("/stats", authAdmin, getDashboardStats);

export default router;
