import express from "express";
import upload from "../middleware/upload.js";
import { uploadFile } from "../controllers/uploadController.js";
import { authAll } from "../middleware/authAll.js";
import { authAdminOrSupportUser } from "../middleware/authAdminOrSupportUser.js";

const router = express.Router();

// Allow authenticated admin, support, or student users to upload files
router.post("/", authAll, upload.single("file"), uploadFile);

export default router;
