import express from "express";
import { createProject, getAllProjects, updateProject, deleteProject, getPublicProjectConfig, getProjectById } from "../controllers/projectsController.js";
import { checkUserHistory } from "../controllers/messageController.js";
import { authAdmin } from "../middleware/authAdmin.js";
import { validateWidgetOrigin } from "../middleware/validateWidgetOrigin.js";

const router = express.Router();

// Protected Routes (Only Admins can create/view projects)
router.post("/create", authAdmin, createProject);
router.get("/all", authAdmin, getAllProjects);
router.get("/:id", authAdmin, getProjectById);
// SECURITY: validateWidgetOrigin checks the Origin/Referer header against the
// project's registered websiteUrl before returning any configuration data.
router.get("/public/:projectId", validateWidgetOrigin, getPublicProjectConfig);
router.get("/history/:projectId/:email", validateWidgetOrigin, checkUserHistory);
router.put("/:id", authAdmin, updateProject);
router.delete("/:id", authAdmin, deleteProject);

export default router;
