import express from "express";
import {
    getQuickReplies,
    createQuickReply,
    updateQuickReply,
    deleteQuickReply
} from "../controllers/quickReplyController.js";
import { authAdminOrSupportUser } from "../middleware/authAdminOrSupportUser.js";

const router = express.Router();

// @desc    Get all quick replies for a user
// @route   GET /api/quick-replies/:userId
router.get("/:userId", authAdminOrSupportUser, getQuickReplies);

// @desc    Create a new quick reply
// @route   POST /api/quick-replies
router.post("/", authAdminOrSupportUser, createQuickReply);

// @desc    Update a quick reply
// @route   PUT /api/quick-replies/:id
router.put("/:id", authAdminOrSupportUser, updateQuickReply);

// @desc    Delete a quick reply
// @route   DELETE /api/quick-replies/:id
router.delete("/:id", authAdminOrSupportUser, deleteQuickReply);

export default router;
