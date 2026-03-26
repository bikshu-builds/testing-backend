import express from "express";
import {
    assignSupportUserToProject,
    removeSupportUserFromProject,
    getProjectsForSupportUser,
    getSupportUsersForProject,
    getAllAssignments,
    getPendingTransfersForSupportUser,
    getAssignmentDataForSupportUser,
    getAssignmentDataForProject,
} from "../controllers/projectSupportUserController.js";

import { authAdmin } from "../middleware/authAdmin.js";
import { authAdminOrSupportUser } from "../middleware/authAdminOrSupportUser.js";

const router = express.Router();

// ADMIN assigns support user to project
router.post("/assign", authAdmin, assignSupportUserToProject);

// ADMIN removes support user from project
router.delete("/:assignmentId", authAdmin, removeSupportUserFromProject);

// ADMIN gets all assignments
router.get("/all", authAdmin, getAllAssignments);

// Get all projects for a specific support user (Admin or Support User can access)
router.get("/support-user/:supportUserId/projects", authAdminOrSupportUser, getProjectsForSupportUser);

// Get pending chat transfers for a specific support user
router.get("/support-user/:supportUserId/pending-transfers", authAdminOrSupportUser, getPendingTransfersForSupportUser);

// ADMIN: Get categorized assignment data (Assigned vs Available)
router.get("/support-user/:supportUserId/assignment-data", authAdmin, getAssignmentDataForSupportUser);

// Get all support users for a specific project
router.get("/project/:projectId/support-users", authAdminOrSupportUser, getSupportUsersForProject);

// ADMIN: Get categorized assignment data for a specific project
router.get("/project/:projectId/assignment-data", authAdmin, getAssignmentDataForProject);




export default router;
