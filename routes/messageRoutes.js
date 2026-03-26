import express from "express";
import {
    getMessages,
    getMessage,
    createMessage,
    updateMessage,
    deleteMessage,
    getUnreadCount,
    markMessagesAsRead,
    searchMessages,
    getChatStats,
    bulkDeleteMessages,
    getChats,
    updateChatStatus,
    deleteChat,
    toggleChatPin,
    getProjectUnreadTotal,
    getChatInfo,
    toggleMessageReaction,
    submitChatRating,
    requestChatRating,
    requestChatReview,
} from "../controllers/messageController.js";
import { authAll } from "../middleware/authAll.js";
import { authAdminOrSupportUser } from "../middleware/authAdminOrSupportUser.js";
import { checkProjectAccess } from "../middleware/checkProjectAccess.js";

const router = express.Router();

// ==================== MESSAGE ROUTES ====================

// Get all chats for a project
router.get("/project/:projectId/chats", authAdminOrSupportUser, checkProjectAccess, getChats);

// Get chat ownership info
router.get("/project/:projectId/chat/:chatId/info", authAdminOrSupportUser, checkProjectAccess, getChatInfo);

// Get total unread messages for a project
router.get("/project/:projectId/unread-total", authAdminOrSupportUser, checkProjectAccess, getProjectUnreadTotal);

// Update chat status
router.patch("/project/:projectId/chat/:chatId/status", authAdminOrSupportUser, checkProjectAccess, updateChatStatus);

// Submit chat rating
router.post("/:projectId/:chatId/rating", authAll, submitChatRating);

// Request chat rating (Support/Admin only)
router.post("/project/:projectId/chat/:chatId/request-rating", authAdminOrSupportUser, checkProjectAccess, requestChatRating);

// Request chat review (Support/Admin only)
router.post("/project/:projectId/chat/:chatId/request-review", authAdminOrSupportUser, checkProjectAccess, requestChatReview);

// Toggle chat pin status
router.patch("/project/:projectId/chat/:chatId/pin", authAdminOrSupportUser, checkProjectAccess, toggleChatPin);

// Delete a chat (permanent)
router.delete("/project/:projectId/chat/:chatId", authAdminOrSupportUser, checkProjectAccess, deleteChat);

// Get all messages for a chat
router.get("/:projectId/:chatId", authAll, checkProjectAccess, getMessages);

// Get single message by ID
router.get("/:projectId/:chatId/:messageId", authAll, checkProjectAccess, getMessage);

// Create a new message
router.post("/:projectId/:chatId", authAll, checkProjectAccess, createMessage);

// Toggle reaction on a message
router.post("/:projectId/:chatId/:messageId/reaction", authAll, checkProjectAccess, toggleMessageReaction);

// Update a message
router.put("/:projectId/:chatId/:messageId", authAll, checkProjectAccess, updateMessage);

// Delete a message (soft delete)
router.delete("/:projectId/:chatId/:messageId", authAdminOrSupportUser, checkProjectAccess, deleteMessage);

// Get unread message count for a user
router.get("/:projectId/:chatId/unread/:userId", authAll, checkProjectAccess, getUnreadCount);

// Mark all messages as read for a user
router.put("/:projectId/:chatId/mark-read/:userId", authAll, checkProjectAccess, markMessagesAsRead);

// Search messages in a chat
router.get("/:projectId/:chatId/search", authAdminOrSupportUser, checkProjectAccess, searchMessages);

// Get chat statistics
router.get("/:projectId/:chatId/stats", authAdminOrSupportUser, checkProjectAccess, getChatStats);

// Bulk delete messages
router.post("/:projectId/:chatId/bulk-delete", authAdminOrSupportUser, checkProjectAccess, bulkDeleteMessages);

export default router;
