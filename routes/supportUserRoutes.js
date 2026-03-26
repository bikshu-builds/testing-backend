import express from "express";
import {
    createSupportUser,
    getAllSupportUsers,
    supportUserLogin,
    deleteSupportUser,
    updateSupportUserPassword,
    toggleSupportUserStatus,
    checkSupportUserStatus,
    getSupportUserCount,
    getSupportUserStats,
    getSupportUsersByProject,
    unlockSupportUser,
    updateSupportUser,
    getNotifications,
    markNotificationsRead,
    getSupportUserProfile,
    requestPasswordResetOTP,
    verifyPasswordResetOTP,
    resetPasswordWithOTP,
    updateFCMToken,
    removeFCMToken,
    forgotPasswordRequestOTP,
    forgotPasswordVerifyOTP,
    forgotPasswordResetPassword,
} from "../controllers/supportUserController.js";
import { getSupportUserPublicInfo } from "../controllers/messageController.js";

import { authAdmin } from "../middleware/authAdmin.js";
import { authSupportUser } from "../middleware/authSupportUser.js";
import { authAdminOrSupportUser } from "../middleware/authAdminOrSupportUser.js";


const router = express.Router();

// ADMIN creates support user
router.post("/create", authAdmin, createSupportUser);

// ADMIN fetch support users
router.get("/all", authAdmin, getAllSupportUsers);

// ADMIN fetch support user count
router.get("/count", authAdmin, getSupportUserCount);

// ADMIN delete support user
router.delete("/:userId", authAdmin, deleteSupportUser);

// ADMIN update support user (name, email, password)
router.put("/:userId", authAdmin, updateSupportUser);

// ADMIN update support user password
router.put("/:userId/password", authAdmin, updateSupportUserPassword);

// ADMIN toggle support user active status
router.patch("/:userId/toggle-status", authAdmin, toggleSupportUserStatus);

// SUPPORT USER login
router.post("/login", supportUserLogin);

// SUPPORT USER check status (requires auth)
router.get("/check-status", authSupportUser, checkSupportUserStatus);

// ADMIN or SUPPORT USER fetch support user stats
router.get("/:userId/stats", authAdminOrSupportUser, getSupportUserStats);

// Get non-sensitive support user info (used in message info panel — accessible by admin and support)
router.get("/:userId/public-info", authAdminOrSupportUser, getSupportUserPublicInfo);

// Get all support users assigned to a project (for the Assign/Transfer UI)
router.get("/project/:projectId", authAdminOrSupportUser, getSupportUsersByProject);

// ADMIN unlock a locked support user account (MED-05)
router.post("/:userId/unlock", authAdmin, unlockSupportUser);

// NOTIFICATIONS (Polling)
router.get("/notifications", authSupportUser, getNotifications);
router.post("/notifications/read", authSupportUser, markNotificationsRead);

// FCM TOKENS
router.post("/fcm-token", authSupportUser, updateFCMToken);
router.delete("/fcm-token", authSupportUser, removeFCMToken);

// --- SUPPORT USER PROFILE & PASSWORD RESET (Self-service) ---

// Get self profile
router.get("/profile", authSupportUser, getSupportUserProfile);

// Request OTP for password reset
router.post("/request-otp", authSupportUser, requestPasswordResetOTP);

// Verify OTP for password reset
router.post("/verify-otp", authSupportUser, verifyPasswordResetOTP);

// Reset password with OTP
router.post("/reset-password", authSupportUser, resetPasswordWithOTP);

// --- UN-AUTHENTICATED FORGOT PASSWORD FLOW (from login page) ---
router.post("/forgot-password/request-otp", forgotPasswordRequestOTP);
router.post("/forgot-password/verify-otp", forgotPasswordVerifyOTP);
router.post("/forgot-password/reset", forgotPasswordResetPassword);

export default router;

