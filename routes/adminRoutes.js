import express from "express";
import { getAdminProfile, loginAdmin, updateAdminFCMToken, removeAdminFCMToken } from "../controllers/adminController.js";
import { authAdmin } from "../middleware/authAdmin.js";

const router = express.Router();

router.post("/login", loginAdmin);
router.get("/profile", authAdmin, getAdminProfile);
router.post("/fcm-token", authAdmin, updateAdminFCMToken);
router.delete("/fcm-token", authAdmin, removeAdminFCMToken);

export default router;
