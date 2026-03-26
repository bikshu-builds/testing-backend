import mongoose from "mongoose";
import { getMessageModel } from "../model/dynamic/messageModel.js";
import { getMetadataModel } from "../model/dynamic/metadataModel.js";
import { getPersonalizedUnreadCount, getChatUnreadCount } from "../utils/unreadCounts.js";
import Project from "../model/project.js";
import SupportUser from "../model/supportUser.js";
import Admin from "../model/Admin.js";
import Notification from "../model/Notification.js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import s3Client from "../config/s3.js";
import { encryptMessageCBC as encryptMessage, decryptMessage } from "../utils/messageEncryption.js";
import { sendFCMMessage } from "../utils/fcmService.js";

// Message length limit (consistent with socket handlers)
const MAX_MESSAGE_LENGTH = 5000;



// ==================== HELPER FUNCTION ====================
/**
 * Sign S3 URL
 */
const signUrl = async (url) => {
    if (!url || typeof url !== 'string' || !url.includes('amazonaws.com')) return url;
    try {
        // Extract key. URL: https://BUCKET.s3.REGION.amazonaws.com/KEY
        const parts = url.split('.amazonaws.com/');
        if (parts.length < 2) return url;
        const key = parts[1];

        const command = new GetObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET,
            Key: key,
        });
        return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    } catch (e) {
        console.error("Error signing URL:", e);
        return url;
    }
};
// ==================== MODEL CACHE (LOW-04 FIX) ====================
// Cache for project models and metadata models to avoid redundant DB reads
const projectCache = new Map();
const modelCache = {
    messages: new Map(), // projectId -> model
    metadata: new Map()  // projectId -> model
};

/**
 * Get message model for a specific project
 * @param {string} projectId - The project ID
 * @returns {Promise<{success: boolean, model?: Model, project?: object, error?: string}>}
 */
const getProjectMessageModel = async (projectId) => {
    try {
        // 1. Check Cache first
        if (projectCache.has(projectId) && modelCache.messages.has(projectId)) {
            return {
                success: true,
                model: modelCache.messages.get(projectId),
                project: projectCache.get(projectId)
            };
        }

        // 2. Cache miss: Fetch project
        const project = await Project.findOne({ projectId });

        if (!project) {
            return { success: false, error: "Project not found" };
        }

        if (!project.collections?.messages) {
            return {
                success: false,
                error: "Message collection not configured for this project",
            };
        }

        const MessageModel = getMessageModel(project.collections.messages);

        // 3. Update Caches
        projectCache.set(projectId, project);
        modelCache.messages.set(projectId, MessageModel);

        return {
            success: true,
            model: MessageModel,
            project,
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
        };
    }
};

/**
 * Get metadata model for a specific project (helper)
 */
const getProjectMetadataModel = async (projectId) => {
    try {
        if (projectCache.has(projectId) && modelCache.metadata.has(projectId)) {
            return {
                success: true,
                model: modelCache.metadata.get(projectId),
                project: projectCache.get(projectId)
            };
        }

        const project = await Project.findOne({ projectId });
        if (!project) return { success: false, error: "Project not found" };

        const MetadataModel = getMetadataModel(project.collections.metadata);

        projectCache.set(projectId, project);
        modelCache.metadata.set(projectId, MetadataModel);

        return { success: true, model: MetadataModel, project };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

// ==================== GET MESSAGES FOR A CHAT ====================
/**
 * Fetch messages for a specific chat with pagination
 * GET /api/messages/:projectId/:chatId
 */
export const getMessages = async (req, res) => {
    try {
        const { projectId, chatId } = req.params;
        const {
            limit = 50,
            skip = 0,
            sortOrder = "asc", // asc = oldest first, desc = newest first
            userId
        } = req.query;

        // ── Resource exhaustion guard ──────────────────────────────────────────
        // Never trust the client-supplied limit. Clamp to a hard server maximum
        // so one request cannot pull millions of rows from the database.
        const MAX_LIMIT = 100;
        const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), MAX_LIMIT);
        const safeSkip = Math.max(parseInt(skip) || 0, 0);
        // ──────────────────────────────────────────────────────────────────────

        // Security Check: If it's a student, they can only access their own chatId
        if (req.student && req.student.chatId !== chatId) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized access to this chat history",
            });
        }

        // Validate required parameters
        if (!projectId || !chatId) {
            return res.status(400).json({
                success: false,
                message: "Project ID and Chat ID are required",
            });
        }

        // Get message model
        const result = await getProjectMessageModel(projectId);
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error,
            });
        }

        const MessageModel = result.model;

        // Build query
        const query = {
            chatId,
            isDeleted: false,
        };

        // Students must never see system messages (e.g. "Resolved conversation" divider)
        // EXCEPT for "New conversation started..." and active rating requests
        if (req.student) {
            query.$or = [
                { senderType: { $ne: 'system' } },
                { senderType: 'system', message: "New conversation started..." },
                // Only include showRating messages where showRating is explicitly true
                // AND isDeleted is false (belt-and-suspenders with the top-level isDeleted:false)
                // AND the message content is specifically the rating request message.
                { senderType: 'system', showRating: true, isDeleted: false, message: "Support has requested a rating" },
                { senderType: 'system', message: /Rating from student/i } // Allow confirmations
            ];
        }

        if (userId) {
            query.deletedBy = { $ne: userId };
        }

        // Fetch messages
        const messagesRaw = await MessageModel.find(query)
            .sort({ createdAt: sortOrder === "desc" ? -1 : 1 })
            .limit(safeLimit)
            .skip(safeSkip)
            .populate({
                path: 'replyTo',
                model: MessageModel,
                select: 'message senderType senderId messageType fileUrl fileName isDeleted status createdAt'
            })
            .lean();

        // ── RELOAD FIX: INJECT VIRTUAL SYSTEM MESSAGE FOR STUDENT WIDGET ──
        if (req.student) {
            try {
                const project = await Project.findOne({ projectId }).lean();
                if (project && project.collections?.metadata) {
                    const MetadataModel = getMetadataModel(project.collections.metadata);
                    const metadata = await MetadataModel.findOne({ chatId }).lean();

                    if (metadata && metadata.resolvedBy && metadata.resolvedBy.length > 0) {
                        const pendingCount = metadata.pendingRatingCount || 0;
                        const totalResolutions = metadata.resolvedBy.length;

                        // We only want to show the LATEST resolution bubble to prevent the UI
                        // from accumulating historical bubbles from previous auto-resolutions.
                        const lastIndex = metadata.resolvedBy.length - 1;
                        const resolverItem = metadata.resolvedBy[lastIndex];

                        if (resolverItem && resolverItem.resolvedAt) {
                            const resolvedTime = resolverItem.resolvedAt;
                            const widgetText = resolverItem.durationString
                                ? `Your chat is resolved in ${resolverItem.durationString}`
                                : `Your chat is resolved.`;

                            const deterministicResolvedTime = new Date(resolvedTime).getTime();

                            // Rating UI only appears via explicit 'Request Rating' — never on resolve
                            const isRatable = false;

                            const virtualMsg = {
                                _id: `virtual_resolved_${chatId}_${deterministicResolvedTime}`,
                                projectId,
                                chatId,
                                senderType: 'system',
                                senderId: null,
                                messageType: 'text',
                                message: widgetText,
                                status: 'sent',
                                createdAt: resolvedTime,
                                showRating: isRatable
                            };

                            // Append to the list exactly where it belongs temporally
                            if (sortOrder === "desc") {
                                // newest first
                                const insertIdx = messagesRaw.findIndex(m => new Date(m.createdAt) <= new Date(resolvedTime));
                                if (insertIdx === -1) messagesRaw.push(virtualMsg);
                                else messagesRaw.splice(insertIdx, 0, virtualMsg);
                            } else {
                                // oldest first
                                const insertIdx = messagesRaw.findIndex(m => new Date(m.createdAt) >= new Date(resolvedTime));
                                if (insertIdx === -1) messagesRaw.push(virtualMsg);
                                else messagesRaw.splice(insertIdx, 0, virtualMsg);
                            }
                        }
                    }
                }
            } catch (virtualErr) {
                console.error("Virtual system message injection error:", virtualErr);
            }
        }
        // ──────────────────────────────────────────────────────────────────

        // Sign URLs for transport (messages sent as plain text)
        const messages = await Promise.all(messagesRaw.map(async (msg) => {
            if (msg.fileUrl) {
                msg.fileUrl = await signUrl(msg.fileUrl);
            }
            if (msg.replyTo && msg.replyTo.fileUrl) {
                msg.replyTo.fileUrl = await signUrl(msg.replyTo.fileUrl);
            }
            // Messages are sent as plain text to frontend
            return msg;
        }));



        // Get total count
        const totalMessages = await MessageModel.countDocuments({
            chatId,
            isDeleted: false,
        });

        return res.status(200).json({
            success: true,
            messages: messages,
            pagination: {
                total: totalMessages,
                limit: safeLimit,
                skip: safeSkip,
                hasMore: totalMessages > safeSkip + safeLimit,
                currentPage: Math.floor(safeSkip / safeLimit) + 1,
                totalPages: Math.ceil(totalMessages / safeLimit),
            },
        });
    } catch (error) {
        console.error("getMessages error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch messages",
        });
    }
};

// ==================== CHECK USER HISTORY ====================
/**
 * Check if a user has previous chat history by email
 * GET /api/projects/public/:projectId/user-history/:email
 */
export const checkUserHistory = async (req, res) => {
    try {
        const { projectId, email } = req.params;

        if (!projectId || !email) {
            return res.status(400).json({
                success: false,
                message: "Project ID and Email are required",
            });
        }

        // 1. Get Project & Metadata Model
        const project = await Project.findOne({ projectId });
        if (!project || !project.collections?.metadata) {
            return res.status(404).json({
                success: false,
                message: "Project or metadata collection not found",
            });
        }

        const MetadataModel = getMetadataModel(project.collections.metadata);

        // 2. Find THE MOST RECENT metadata record for this email (Direct match - FASTEST)
        const metadata = await MetadataModel.findOne({
            email: email.toLowerCase(),
            isDeleted: { $ne: true }
        })
            .sort({ updatedAt: -1 })
            .lean();

        if (metadata) {
            return res.status(200).json({
                success: true,
                chatId: metadata.chatId,
                userId: metadata.userId,
                name: metadata.name,
                status: metadata.status
            });
        }

        return res.status(200).json({
            success: false,
            message: "No history found for this email",
        });
    } catch (error) {
        console.error("checkUserHistory error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to check user history",
        });
    }
};

// ==================== GET SINGLE MESSAGE ====================
/**
 * Fetch a single message by ID
 * GET /api/messages/:projectId/:chatId/:messageId
 */
export const getMessage = async (req, res) => {
    try {
        const { projectId, messageId } = req.params;

        if (!projectId || !messageId) {
            return res.status(400).json({
                success: false,
                message: "Project ID and Message ID are required",
            });
        }

        const result = await getProjectMessageModel(projectId);
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error,
            });
        }

        const MessageModel = result.model;
        const message = await MessageModel.findById(messageId).lean();

        if (!message) {
            return res.status(404).json({
                success: false,
                message: "Message not found",
            });
        }

        if (message.isDeleted) {
            return res.status(410).json({
                success: false,
                message: "Message has been deleted",
            });
        }

        // Security check for student users
        if (req.student && message.chatId !== req.student.chatId) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized access to this message",
            });
        }

        if (message.fileUrl) {
            message.fileUrl = await signUrl(message.fileUrl);
        }

        // Message sent as plain text to frontend



        return res.status(200).json({
            success: true,
            message: message,
        });
    } catch (error) {
        console.error("getMessage error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch message",
        });
    }
};

// ==================== CREATE MESSAGE ====================
/**
 * Create a new message (typically used for REST API, Socket.IO handles real-time)
 * POST /api/messages/:projectId/:chatId
 */
export const createMessage = async (req, res) => {
    try {
        const { projectId, chatId } = req.params;
        const {
            messageType = "text",
            message,
            fileUrl,
            fileName,
            replyTo,
            isBold = false,
        } = req.body;

        // Security Check: If it's a student, they can only access their own chatId
        if (req.student && req.student.chatId !== chatId) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized access to this chat history",
            });
        }

        // Validate required fields
        if (!projectId || !chatId) {
            return res.status(400).json({
                success: false,
                message: "Project ID and Chat ID are required",
            });
        }

        // Determine true senderType and senderId based on verified token
        let actualSenderType = "student";
        let actualSenderId = null;

        if (req.userType === "admin") {
            actualSenderType = "support"; // Admin acts as support in chat context
            actualSenderId = req.admin.adminId;
        } else if (req.userType === "support") {
            actualSenderType = "support";
            actualSenderId = req.supportUser.id;
        } else if (req.userType === "student") {
            actualSenderType = "student";
            actualSenderId = null; // Students don't need a formal senderId in this system
        }

        if (!actualSenderType) {
            return res.status(400).json({
                success: false,
                message: "Sender type could not be determined",
            });
        }

        if (messageType === 'text' && !message) {
            return res.status(400).json({
                success: false,
                message: "Message content is required for text messages",
            });
        }

        if (!["student", "support"].includes(actualSenderType)) {
            return res.status(400).json({
                success: false,
                message: "Sender type must be 'student' or 'support'",
            });
        }

        if (!["text", "image", "file"].includes(messageType)) {
            return res.status(400).json({
                success: false,
                message: "Message type must be 'text', 'image', or 'file'",
            });
        }

        // Ownership check removed: "Active Assignee" logic allows any support user to message
        // and automatically take active control.

        // Get message model
        const result = await getProjectMessageModel(projectId);
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error,
            });
        }

        const MessageModel = result.model;

        // Decrypt incoming message if it's text
        let plainMessage = message;
        if (messageType === 'text' && message) {
            plainMessage = decryptMessage(message);
        }

        // ── Message length guard ──────────────────────────────────────────────
        if (messageType === 'text' && plainMessage && plainMessage.length > MAX_MESSAGE_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `Message is too long. Maximum ${MAX_MESSAGE_LENGTH.toLocaleString()} characters allowed.`,
            });
        }
        // ─────────────────────────────────────────────────────────────────────
        // Create new message with decrypted content (stored decrypted in DB)
        const newMessage = new MessageModel({
            projectId,
            chatId,
            senderType: actualSenderType,
            senderId: actualSenderId,
            messageType,
            message: plainMessage, // Store decrypted
            fileUrl: fileUrl || null,
            fileName: fileName || null,
            replyTo: replyTo || null,
            isBold,
            status: "sent",
        });

        await newMessage.save();

        // ── SYNC METADATA (Pending -> Unresolved) ─────────────────────────
        try {
            const project = await Project.findOne({ projectId });
            if (project && project.collections?.metadata) {
                const MetadataModel = getMetadataModel(project.collections.metadata);

                let metadata = null;

                if (actualSenderType === 'student') {
                    // Create metadata if first message from student
                    metadata = await MetadataModel.findOne({ chatId });
                    if (!metadata) {
                        metadata = await MetadataModel.create({
                            projectId,
                            chatId,
                            userId: req.student.userId,
                            status: "pending",
                            transferHistory: [[]], // one fresh empty session
                            helpCycles: [{ startedAt: new Date() }] // Start the first help cycle
                        });
                    } else if (!metadata.helpCycles || metadata.helpCycles.length === 0) {
                        // Chat was pre-created in join_chat (e.g. they provided email), but this is their first real message!
                        const cycleStart = new Date();
                        await MetadataModel.updateOne(
                            { chatId },
                            { $set: { helpCycles: [{ startedAt: cycleStart }], isDeleted: false } }
                        );
                        metadata.helpCycles = [{ startedAt: cycleStart }];
                    } else if (metadata.status === 'resolved') {
                        // ── AUTO-UNRESOLVE ──────────────────────────────────────────────
                        // A new student message arrived on a resolved chat.
                        // Flip status back to unresolved and start a brand-new transfer session
                        // by pushing an empty inner-array onto transferHistory.
                        await MetadataModel.updateOne(
                            { chatId },
                            {
                                // Snapshot this session's assistants into permanent history,
                                // then clear so the new session starts fresh
                                $set: {
                                    status: 'unresolved',
                                    assistants: [],
                                    ratingRequested: false,
                                    pendingRatingCount: 0
                                },
                                $push: {
                                    assistantHistory: metadata.assistants || [], // save previous session
                                    transferHistory: [],                         // new transfer session
                                    helpCycles: { startedAt: newMessage.createdAt } // exact timestamp of the re-open message
                                },
                            }
                        );

                        // Clean up any leftover showRating messages from the previous session
                        // so they don't reappear when the student reloads the widget
                        await MessageModel.updateMany(
                            { chatId, showRating: true },
                            { $set: { showRating: false, isDeleted: true } }
                        );

                        // Broadcast real-time status change to support dashboard
                        const io = req.app.get('io');
                        if (io) {
                            const statusChangeToken = encryptMessage(JSON.stringify({
                                chatId,
                                projectId,
                                status: 'unresolved',
                                autoUnresolved: true,
                                pendingRatingCount: 0,
                                ratingRequested: false,
                            }));
                            io.to(`project_${projectId}`).emit('chat_status_changed', { token: statusChangeToken });
                            io.to(`${projectId}_${chatId}`).emit('chat_status_changed', { token: statusChangeToken });
                        }

                    } else if (metadata.isDeleted) {
                        // Chat was deleted but not resolved, and has helpCycles - simply un-delete
                        await MetadataModel.updateOne(
                            { chatId },
                            { $set: { isDeleted: false } }
                        );
                    }
                } else if (actualSenderType === 'support' || actualSenderType === 'admin') {
                    // Agent reply: Move to unresolved and set assignment if needed
                    metadata = await MetadataModel.findOne({ chatId });
                    let isFirstReplyClaim = false;
                    const agentId = actualSenderId ? String(actualSenderId) : null;

                    if (!agentId) {
                        return res.status(400).json({ success: false, message: "Invalid sender ID" });
                    }

                    if (agentId) {
                        // Check assignment lock
                        if (metadata && metadata.assignedTo && String(metadata.assignedTo) !== agentId) {
                            return res.status(403).json({
                                success: false,
                                message: "This chat is currently assigned to another agent. You cannot send messages until it is released."
                            });
                        }
                        const updateObj = {};
                        if (!metadata) {
                            metadata = await MetadataModel.create({
                                projectId,
                                chatId,
                                originalAssignedTo: agentId,
                                assignedTo: agentId,
                                assistants: [agentId],
                                status: "unresolved",
                                helpCycles: [{ startedAt: new Date(), pickedUpAt: new Date(), pickedUpBy: agentId }]
                            });
                            isFirstReplyClaim = true;
                        } else {
                            if (metadata.status === 'pending') {
                                updateObj.status = 'unresolved';
                            }
                            if (metadata.isDeleted) {
                                updateObj.isDeleted = false;
                            }

                            // ── ACTIVE ASSIGNEE LOGIC ──
                            // Every support/admin message automatically makes them the active owner
                            updateObj.assignedTo = agentId;
                            if (!metadata.originalAssignedTo || ['system', 'bot'].includes(metadata.originalAssignedTo)) {
                                updateObj.originalAssignedTo = agentId;
                                isFirstReplyClaim = true;
                            }

                            // COMBINED RESOLUTION: Unified DB Update
                            let cycleUpdateOps = null;
                            if (metadata && metadata.helpCycles && metadata.helpCycles.length > 0) {
                                const lastCycleIdx = metadata.helpCycles.length - 1;
                                const lastCycle = metadata.helpCycles[lastCycleIdx];
                                if (!lastCycle.pickedUpAt) {
                                    cycleUpdateOps = {
                                        $set: {
                                            [`helpCycles.${lastCycleIdx}.pickedUpAt`]: new Date(),
                                            [`helpCycles.${lastCycleIdx}.pickedUpBy`]: agentId
                                        }
                                    };
                                }
                            }

                            const mongoUpdate = {};
                            const setOps = { ...updateObj };
                            if (cycleUpdateOps && cycleUpdateOps.$set) {
                                Object.assign(setOps, cycleUpdateOps.$set);
                            }
                            if (Object.keys(setOps).length > 0) {
                                mongoUpdate.$set = setOps;
                            }
                            mongoUpdate.$addToSet = { assistants: agentId };

                            await MetadataModel.updateOne({ chatId }, mongoUpdate);

                            // Notify frontend about the ownership change
                            const io = req.app.get('io');
                            if (io) {
                                const updateToken = encryptMessage(JSON.stringify({
                                    chatId,
                                    projectId,
                                    assignedTo: agentId,
                                    isSilent: true // don't show alert
                                }));
                                io.to(`${projectId}_${chatId}`).emit('assignment_updated', { token: updateToken });
                            }
                        }

                        // Broadcast chat claim to clear unread badges for other support users
                        if (isFirstReplyClaim) {
                            const io = req.app.get('io');
                            if (io) {
                                try {
                                    const projectRoomSockets = await io.in(`project_${projectId}`).fetchSockets();
                                    const seenUsers = new Set();
                                    for (const s of projectRoomSockets) {
                                        const uid = s.user?.id ? String(s.user.id) : null;
                                        if (!uid || seenUsers.has(uid) || uid === agentId) continue;
                                        seenUsers.add(uid);
                                        const role = s.user?.role || 'support';
                                        try {
                                            const [personalizedTotal, personalizedChatCount] = await Promise.all([
                                                getPersonalizedUnreadCount(project, uid, role),
                                                getChatUnreadCount(project, chatId, uid, role)
                                            ]);
                                            const unreadUpdatePayload = {
                                                projectId,
                                                chatId,
                                                type: 'chat_assigned',
                                                totalUnreadCount: personalizedTotal,
                                                unreadCount: personalizedChatCount
                                            };
                                            const clearToken = encryptMessage(JSON.stringify(unreadUpdatePayload));
                                            io.to(`user_${uid}`).emit("unread_count_update", { token: clearToken });
                                        } catch (err) {
                                            console.error("Failed to clear stale unread count in createMessage for", uid, err);
                                        }
                                    }
                                } catch (claimErr) {
                                    console.error("Error broadcasting chat claim from createMessage:", claimErr);
                                }
                            }
                        }
                    }
                }

                // ── UPDATE TIMEOUT METADATA (AGENT ONLY) ────────────────
                // We only update lastMessageDetails when an agent (support/admin) messages.
                // If a student messages, we leave it exactly as it was (capturing the last agent's details).
                if (actualSenderType === 'support' || actualSenderType === 'admin') {
                    await MetadataModel.updateOne(
                        { chatId },
                        {
                            $set: {
                                lastMessageDetails: {
                                    timestamp: newMessage.createdAt,
                                    senderRole: actualSenderType,
                                    chatId: chatId,
                                    activeAssigneeAtTimeOfMessage: metadata?.assignedTo || null
                                }
                            }
                        }
                    );
                }
            }
        } catch (err) {
            console.error("Error syncing metadata in createMessage:", err.message);
        }
        // Emit socket event if io is available
        const io = req.app.get("io");

        await newMessage.populate({
            path: 'replyTo',
            model: MessageModel,
            select: 'message senderType senderId messageType fileUrl fileName isDeleted status createdAt'
        });

        const messageObject = newMessage.toObject();

        // Sign URL for immediate display
        if (messageObject.fileUrl) {
            messageObject.fileUrl = await signUrl(messageObject.fileUrl);
        }

        if (io) {
            const roomKey = `${projectId}_${chatId}`;
            // Encrypt for broadcast (Full Payload Token)
            const token = encryptMessage(JSON.stringify(messageObject));
            io.to(roomKey).emit("new_message", { token });

            // ── EMIT UNREAD COUNT UPDATE FOR ALL MESSAGES ─────────────────────────────
            // Notify project room for sidebar/dashboard unread count update
            // This ensures deleted chats get resurrected via forceFetchChat when any new message arrives
            const totalUnreadCount = await MessageModel.countDocuments({
                senderType: 'student',
                status: { $ne: 'seen' },
                isDeleted: false
            });

            const chatUnreadCount = await MessageModel.countDocuments({
                chatId,
                senderType: 'student',
                status: { $ne: 'seen' },
                isDeleted: false
            });

            const unreadPayload = {
                projectId,
                chatId,
                type: 'new_message',
                totalUnreadCount,
                unreadCount: chatUnreadCount
            };
            const unreadToken = encryptMessage(JSON.stringify(unreadPayload));
            io.to(`project_${projectId}`).emit("unread_count_update", { token: unreadToken });
            // ────────────────────────────────────────────────────────────────────────────

            // ── PERSISTENT NOTIFICATION FOR STUDENT MESSAGE ONLY ────────────────────
            if (actualSenderType === 'student') {
                try {
                    const MetadataModel = getMetadataModel(project.collections.metadata);
                    const chatMeta = await MetadataModel.findOne({ chatId }).lean();
                    const assignedToId = chatMeta?.assignedTo || chatMeta?.originalAssignedTo || null;

                    const notificationData = {
                        type: 'new_message',
                        title: `New message from ${chatMeta?.name || chatMeta?.email || 'Student'}`,
                        body: plainMessage || 'Sent a file',
                        chatId,
                        projectId,
                    };

                    if (assignedToId) {
                        const newNotification = await Notification.create({ ...notificationData, userId: assignedToId });
                        // Send FCM push notification (fire and forget)
                        sendFCMMessage(assignedToId, {
                            title: newNotification.title,
                            body: newNotification.body,
                            type: newNotification.type,
                            chatId: newNotification.chatId,
                            projectId: newNotification.projectId,
                            _id: newNotification._id
                        }).catch(console.error);
                    } else {
                        const ProjectSupportUser = (await import('../model/ProjectSupportUser.js')).default;
                        const assignments = await ProjectSupportUser.find({
                            projectId: project._id,
                            isActive: true
                        }).lean();

                        const notifications = assignments.map(a => ({
                            ...notificationData,
                            userId: a.supportUserId
                        }));
                        if (notifications.length > 0) {
                            const createdNotifications = await Notification.insertMany(notifications);
                            // Send FCM push notifications to all assigned users (fire and forget)
                            for (const notif of createdNotifications) {
                                sendFCMMessage(notif.userId, {
                                    title: notif.title,
                                    body: notif.body,
                                    type: notif.type,
                                    chatId: notif.chatId,
                                    projectId: notif.projectId,
                                    _id: notif._id
                                }).catch(console.error);
                            }
                        }
                    }
                } catch (notifyErr) {
                    console.error("Error saving student message notifications in createMessage:", notifyErr);
                }
            }
            // ────────────────────────────────────────────────────────────────────────────
        }

        // ── Auto-Resolve Tracking (Only support/admin messages start/reset the inactivity timer) ──
        try {
            // Only start/reset the auto-resolve timer if a support or admin replies
            if (actualSenderType === 'support' || actualSenderType === 'admin') {
                const projectDoc = await Project.findOne({ projectId });
                if (projectDoc && projectDoc.collections?.metadata) {
                    const MetadataModel = getMetadataModel(projectDoc.collections.metadata);
                    const metaForTracking = await MetadataModel.findOne({ chatId }).lean();
                    const activeAssignee = metaForTracking?.assignedTo || metaForTracking?.originalAssignedTo || null;

                    await MetadataModel.updateOne(
                        { chatId },
                        {
                            $set: {
                                lastMessageDetails: {
                                    timestamp: newMessage.createdAt,
                                    senderRole: actualSenderType,
                                    chatId: chatId,
                                    activeAssigneeAtTimeOfMessage: activeAssignee ? String(activeAssignee) : null
                                }
                            }
                        }
                    );
                }
            }
        } catch (metaErr) {
            console.error("Error updating lastMessageDetails for auto-resolve:", metaErr);
        }
        // ────────────────────────────────────────────────────────

        return res.status(201).json({
            success: true,
            message: "Message created successfully",
            data: messageObject,
        });
    } catch (error) {
        console.error("createMessage error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create message",
        });
    }
};

// ==================== UPDATE MESSAGE ====================
/**
 * Update a message (for editing)
 * PUT /api/messages/:projectId/:chatId/:messageId
 */
export const updateMessage = async (req, res) => {
    try {
        const { projectId, messageId } = req.params;
        const { message, messageType } = req.body;

        if (!projectId || !messageId) {
            return res.status(400).json({
                success: false,
                message: "Project ID and Message ID are required",
            });
        }

        if (!message) {
            return res.status(400).json({
                success: false,
                message: "Message content is required",
            });
        }

        const result = await getProjectMessageModel(projectId);
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error,
            });
        }

        const MessageModel = result.model;

        const existingMessage = await MessageModel.findById(messageId);
        if (!existingMessage) {
            return res.status(404).json({
                success: false,
                message: "Message not found",
            });
        }

        // Security check for student users
        if (req.student) {
            if (existingMessage.senderType !== 'student' ||
                existingMessage.chatId !== req.student.chatId ||
                (req.student.userId && String(existingMessage.senderId) !== String(req.student.userId))) {
                return res.status(403).json({
                    success: false,
                    message: "You can only edit your own messages within your own chat",
                });
            }
        }

        // ── 15-MINUTE EDIT WINDOW CHECK ───────────────────────────────────────
        const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
        const messageAge = Date.now() - new Date(existingMessage.createdAt).getTime();
        if (messageAge > EDIT_WINDOW_MS) {
            return res.status(403).json({
                success: false,
                message: "Messages can only be edited within 15 minutes of sending",
            });
        }
        // ─────────────────────────────────────────────────────────────────────

        // Decrypt incoming message if it's text
        let plainMessage = message;
        if (messageType === 'text' && message) {
            plainMessage = decryptMessage(message);
        }

        // ── Message length guard ──────────────────────────────────────────────
        if (messageType === 'text' && plainMessage && plainMessage.length > MAX_MESSAGE_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `Message is too long. Maximum ${MAX_MESSAGE_LENGTH.toLocaleString()} characters allowed.`,
            });
        }
        // ─────────────────────────────────────────────────────────────────────

        const updatedMessage = await MessageModel.findByIdAndUpdate(
            messageId,
            {
                message: plainMessage,
                ...(messageType && { messageType }),
                isEdited: true,
                editedAt: new Date(),
                updatedAt: new Date(),
            },
            { new: true, runValidators: true }
        );

        const updatedMessageObject = updatedMessage.toObject();
        if (updatedMessageObject.fileUrl) {
            updatedMessageObject.fileUrl = await signUrl(updatedMessageObject.fileUrl);
        }



        // Emit socket event
        const io = req.app.get("io");
        if (io) {
            const roomKey = `${projectId}_${updatedMessage.chatId}`;
            // Encrypt for broadcast (Full Payload Token)
            const token = encryptMessage(JSON.stringify(updatedMessageObject));
            io.to(roomKey).emit("message_updated", { token });
        }

        return res.status(200).json({
            success: true,
            message: "Message updated successfully",
            data: updatedMessageObject,
        });
    } catch (error) {
        console.error("updateMessage error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update message",
        });
    }
};

// ==================== DELETE MESSAGE ====================
/**
 * Soft delete a message
 * DELETE /api/messages/:projectId/:chatId/:messageId
 */
export const deleteMessage = async (req, res) => {
    try {
        const { projectId, chatId, messageId } = req.params;
        const { deleteType, userId } = req.body; // 'everyone' or 'me'

        if (!projectId || !messageId) {
            return res.status(400).json({
                success: false,
                message: "Project ID and Message ID are required",
            });
        }

        const result = await getProjectMessageModel(projectId);
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error,
            });
        }

        const MessageModel = result.model;

        // ── Load the message first ────────────────────────────────────────────
        // We need the message before we can check ownership and apply the update.
        const existingMessage = await MessageModel.findById(messageId);
        if (!existingMessage) {
            return res.status(404).json({
                success: false,
                message: "Message not found",
            });
        }

        // ── Ownership check for support users ────────────────────────────────
        // Admins (req.admin is set) may delete any message.
        // Support users may only delete messages where they are the original sender.
        // This route is protected by authAdminOrSupportUser, so req.admin or
        // req.supportUser is always present.
        if (req.supportUser && !req.admin) {
            const callerId = String(req.supportUser.id);
            const isOwner = String(existingMessage.senderId) === callerId;
            if (!isOwner) {
                return res.status(403).json({
                    success: false,
                    message: "You do not have permission to delete this message.",
                });
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        let update = {};

        if (deleteType === 'me') {
            if (!userId) {
                return res.status(400).json({
                    success: false,
                    message: "User ID is required for 'delete for me'",
                });
            }
            update = { $addToSet: { deletedBy: userId } };
        } else {
            // Default to delete for everyone
            update = { isDeleted: true };
        }

        const deletedMessage = await MessageModel.findByIdAndUpdate(
            messageId,
            update,
            { new: true }
        );

        // Emit socket event
        const io = req.app.get("io");
        if (io) {
            const roomKey = `${projectId}_${chatId}`;
            const deletePayload = {
                messageId,
                deleteType: deleteType || 'everyone',
                userId
            };
            const deleteToken = encryptMessage(JSON.stringify(deletePayload));
            io.to(roomKey).emit("message_deleted", { token: deleteToken });

            // Force hard delete for the Student Frontend (which ignores 'everyone' filtering)
            if ((deleteType || 'everyone') === 'everyone') {
                // Find student's senderId from any message they sent in this chat
                const studentMsg = await MessageModel.findOne({ chatId, senderType: 'student' });
                const studentUserId = studentMsg ? studentMsg.senderId : chatId;

                const purgePayload = {
                    messageId,
                    deleteType: 'me',
                    userId: studentUserId
                };
                const purgeToken = encryptMessage(JSON.stringify(purgePayload));
                io.to(roomKey).emit("message_deleted", { token: purgeToken });
            }
        }

        return res.status(200).json({
            success: true,
            message: "Message deleted successfully",
        });
    } catch (error) {
        console.error("deleteMessage error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete message",
        });
    }
};

// ==================== GET UNREAD MESSAGE COUNT ====================
/**
 * Get count of unread messages for a user in a chat
 * GET /api/messages/:projectId/:chatId/unread/:userId
 */
export const getUnreadCount = async (req, res) => {
    try {
        const { projectId, chatId, userId } = req.params;

        if (!projectId || !chatId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Project ID, Chat ID, and User ID are required",
            });
        }

        // Security Check: If it's a student, they can only access their own chatId and userId
        if (req.student) {
            if (req.student.chatId !== chatId || req.student.userId !== userId) {
                return res.status(403).json({
                    success: false,
                    message: "Unauthorized access to this unread count",
                });
            }
        }

        const result = await getProjectMessageModel(projectId);
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error,
            });
        }

        const MessageModel = result.model;

        // Count messages not sent by this user and not read
        const unreadCount = await MessageModel.countDocuments({
            chatId,
            senderId: { $ne: userId },
            status: { $ne: "seen" },
            isDeleted: false,
        });

        return res.status(200).json({
            success: true,
            unreadCount,
        });
    } catch (error) {
        console.error("getUnreadCount error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch unread count",
        });
    }
};

// ==================== MARK MESSAGES AS READ ====================
/**
 * Mark all messages in a chat as read for a user
 * PUT /api/messages/:projectId/:chatId/mark-read/:userId
 */
export const markMessagesAsRead = async (req, res) => {
    try {
        const { projectId, chatId, userId } = req.params;

        if (!projectId || !chatId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Project ID, Chat ID, and User ID are required",
            });
        }

        // Security Check: If it's a student, they can only mark messages in their own chatId
        if (req.student && req.student.chatId !== chatId) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized access to this chat history",
            });
        }

        const result = await getProjectMessageModel(projectId);
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error,
            });
        }

        const MessageModel = result.model;

        // Fetch metadata to check assignment
        const project = await Project.findOne({ projectId });
        if (!project) {
            return res.status(404).json({ success: false, message: "Project not found" });
        }
        const MetadataModel = getMetadataModel(project.collections.metadata);
        const meta = await MetadataModel.findOne({ chatId }).lean();
        const assignedId = meta?.assignedTo ? String(meta.assignedTo) : null;
        const origId = (meta?.originalAssignedTo &&
            !['system', 'bot'].includes(String(meta.originalAssignedTo)))
            ? String(meta.originalAssignedTo) : null;
        const owner = assignedId ?? origId;

        // Build query to mark messages as read
        const query = {
            chatId,
            status: { $ne: "seen" },
            isDeleted: false,
        };

        let shouldMarkGloballySeen = false;
        if (req.student) {
            // Student reading support messages → always mark as seen
            query.senderType = { $in: ["support", "admin"] };
            shouldMarkGloballySeen = true;
        } else if (req.supportUser || req.admin) {
            query.senderType = "student";

            // If a support user or admin sees the message, mark as read globally
            shouldMarkGloballySeen = true;

            // Always add to per-user seen list and update last seen timestamp
            // (for notification badge purposes, regardless of assignment)
            const now = new Date();
            await MetadataModel.updateOne(
                { chatId },
                {
                    $addToSet: { notificationsSeenBy: userId },
                    $set: { [`userLastSeenAt.${userId}`]: now }
                }
            );
        } else {
            query.senderId = { $ne: userId };
            if (owner === userId) shouldMarkGloballySeen = true;
        }

        let modifiedCount = 0;
        if (shouldMarkGloballySeen) {
            const updateResult = await MessageModel.updateMany(
                query,
                {
                    status: "seen",
                    readAt: new Date(),
                }
            );
            modifiedCount = updateResult.modifiedCount;
        }

        // Emit socket event
        const io = req.app.get("io");
        if (io) {
            const roomKey = `${projectId}_${chatId}`;

            const payload = {
                chatId,
                userId,
                count: modifiedCount,
            };
            const token = encryptMessage(JSON.stringify(payload));
            io.to(roomKey).emit("messages_marked_read", { token });

            // 🔥 FIX: Also emit status update so student side gets blue ticks in real-time
            if (shouldMarkGloballySeen && modifiedCount > 0) {
                const statusPayload = {
                    chatId,
                    status: "seen",
                    readAt: new Date(),
                    bulk: true
                };
                const statusToken = encryptMessage(JSON.stringify(statusPayload));
                io.to(roomKey).emit("message_status_updated", { token: statusToken });
            }

            // ── PER-USER personalised unread_count_update ───────────────────────
            // Notify ALL project members (Admins, etc.) so their total counts update.
            const projectRoomSockets = await io.in(`project_${projectId}`).fetchSockets();
            const seenUserIds = new Set();
            for (const s of projectRoomSockets) {
                const uid = s.user?.id ? String(s.user.id) : null;
                if (!uid || seenUserIds.has(uid)) continue;
                seenUserIds.add(uid);
                const role = s.user?.role || 'support';

                try {
                    const personalizedTotal = await getPersonalizedUnreadCount(project, uid, role);
                    const personalizedChatCount = await getChatUnreadCount(project, chatId, uid, role);

                    const unreadUpdatePayload = {
                        projectId,
                        chatId,
                        type: 'read',
                        totalUnreadCount: personalizedTotal,
                        unreadCount: personalizedChatCount
                    };
                    const unreadUpdateToken = encryptMessage(JSON.stringify(unreadUpdatePayload));
                    io.to(`user_${uid}`).emit("unread_count_update", { token: unreadUpdateToken });
                } catch (err) {
                    console.error(`Failed to sync unread count for user ${uid} after REST read:`, err);
                }
            }
        }

        return res.status(200).json({
            success: true,
            message: "Messages marked as read",
            markedCount: modifiedCount,
        });
    } catch (error) {
        console.error("markMessagesAsRead error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to mark messages as read",
        });
    }
};

// ==================== SEARCH MESSAGES ====================
/**
 * Search messages in a chat
 * GET /api/messages/:projectId/:chatId/search?query=searchTerm
 */
export const searchMessages = async (req, res) => {
    try {
        const { projectId, chatId } = req.params;
        const { query, limit = 20, messageType } = req.query;

        // ── Resource exhaustion guard ──────────────────────────────────────────
        const MAX_SEARCH_LIMIT = 50;
        const safeLimit = Math.min(Math.max(parseInt(limit) || 20, 1), MAX_SEARCH_LIMIT);
        // ──────────────────────────────────────────────────────────────────────

        if (!projectId || !chatId) {
            return res.status(400).json({
                success: false,
                message: "Project ID and Chat ID are required",
            });
        }

        if (!query) {
            return res.status(400).json({
                success: false,
                message: "Search query is required",
            });
        }

        const result = await getProjectMessageModel(projectId);
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error,
            });
        }

        const MessageModel = result.model;

        // SECURITY: Escape regex special characters to prevent ReDoS and injection
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Build search filter
        const searchFilter = {
            chatId,
            message: { $regex: escapedQuery, $options: "i" },
            isDeleted: false,
        };

        if (messageType) {
            searchFilter.messageType = messageType;
        }

        const messagesRaw = await MessageModel.find(searchFilter)
            .sort({ createdAt: -1 })
            .limit(safeLimit)
            .lean();

        // Sign URLs (messages sent as plain text)
        const messages = await Promise.all(messagesRaw.map(async (msg) => {
            if (msg.fileUrl) {
                msg.fileUrl = await signUrl(msg.fileUrl);
            }
            // Messages sent as plain text to frontend
            return msg;
        }));



        return res.status(200).json({
            success: true,
            messages: messages,
            count: messages.length,
            query,
        });
    } catch (error) {
        console.error("searchMessages error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to search messages",
        });
    }
};

// ==================== GET CHAT STATISTICS ====================
/**
 * Get statistics for a chat (total messages, unread, by type, etc.)
 * GET /api/messages/:projectId/:chatId/stats
 */
export const getChatStats = async (req, res) => {
    try {
        const { projectId, chatId } = req.params;
        const { userId } = req.query;

        if (!projectId || !chatId) {
            return res.status(400).json({
                success: false,
                message: "Project ID and Chat ID are required",
            });
        }

        const result = await getProjectMessageModel(projectId);
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error,
            });
        }

        const MessageModel = result.model;

        // Get various statistics
        const [
            totalMessages,
            textMessages,
            imageMessages,
            fileMessages,
            deletedMessages,
            unreadMessages,
        ] = await Promise.all([
            MessageModel.countDocuments({ chatId, isDeleted: false }),
            MessageModel.countDocuments({ chatId, messageType: "text", isDeleted: false }),
            MessageModel.countDocuments({ chatId, messageType: "image", isDeleted: false }),
            MessageModel.countDocuments({ chatId, messageType: "file", isDeleted: false }),
            MessageModel.countDocuments({ chatId, isDeleted: true }),
            userId
                ? MessageModel.countDocuments({
                    chatId,
                    senderId: { $ne: userId },
                    status: { $ne: "seen" },
                    isDeleted: false,
                })
                : 0,
        ]);

        // Get first and last message timestamps
        const firstMessage = await MessageModel.findOne({ chatId, isDeleted: false })
            .sort({ createdAt: 1 })
            .select("createdAt")
            .lean();

        const lastMessage = await MessageModel.findOne({ chatId, isDeleted: false })
            .sort({ createdAt: -1 })
            .select("createdAt")
            .lean();

        return res.status(200).json({
            success: true,
            stats: {
                totalMessages,
                messagesByType: {
                    text: textMessages,
                    image: imageMessages,
                    file: fileMessages,
                },
                deletedMessages,
                unreadMessages,
                firstMessageAt: firstMessage?.createdAt || null,
                lastMessageAt: lastMessage?.createdAt || null,
            },
        });
    } catch (error) {
        console.error("getChatStats error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch chat statistics",
        });
    }
};

// ==================== BULK DELETE MESSAGES ====================
/**
 * Bulk delete messages (soft delete)
 * POST /api/messages/:projectId/:chatId/bulk-delete
 */
export const bulkDeleteMessages = async (req, res) => {
    try {
        const { projectId, chatId } = req.params;
        const { messageIds } = req.body;

        if (!projectId || !chatId) {
            return res.status(400).json({
                success: false,
                message: "Project ID and Chat ID are required",
            });
        }

        if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Message IDs array is required",
            });
        }

        const result = await getProjectMessageModel(projectId);
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error,
            });
        }

        const MessageModel = result.model;

        const updateResult = await MessageModel.updateMany(
            {
                _id: { $in: messageIds },
                chatId,
            },
            { isDeleted: true }
        );

        // Emit socket event
        const io = req.app.get("io");
        if (io) {
            const roomKey = `${projectId}_${chatId}`;
            const bulkDeletePayload = {
                messageIds,
                count: updateResult.modifiedCount,
            };
            const bulkDeleteToken = encryptMessage(JSON.stringify(bulkDeletePayload));
            io.to(roomKey).emit("messages_bulk_deleted", { token: bulkDeleteToken });
        }

        return res.status(200).json({
            success: true,
            message: "Messages deleted successfully",
            deletedCount: updateResult.modifiedCount,
        });
    } catch (error) {
        console.error("bulkDeleteMessages error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete messages",
        });
    }
};

// ==================== GET CHATS FOR PROJECT ====================
/**
 * Get all chats for a project with last message and unread count
 * GET /api/messages/project/:projectId/chats
 */
export const getChats = async (req, res) => {
    try {
        const { projectId } = req.params;

        if (!projectId) {
            return res.status(400).json({
                success: false,
                message: "Project ID is required",
            });
        }

        const project = await Project.findOne({ projectId });
        if (!project) {
            return res.status(404).json({ success: false, message: "Project not found" });
        }

        const result = await getProjectMessageModel(projectId);
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error,
            });
        }

        const MessageModel = result.model;
        const metadataCollectionName = project.collections.metadata;

        const aggregationPipeline = [
            // 1. Filter out deleted messages FIRST so they never affect lastMessage preview or counts
            { $match: { isDeleted: false } },

            // 2. Sort by creation time descending to get latest messages first
            { $sort: { createdAt: -1 } },

            // 2. Group by chatId
            {
                $group: {
                    _id: "$chatId",
                    lastMessage: { $first: "$$ROOT" },
                    unreadCount: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ["$senderType", "student"] },
                                        { $ne: ["$status", "seen"] },
                                        { $eq: ["$isDeleted", false] }
                                    ]
                                },
                                1,
                                0
                            ]
                        }
                    },
                    totalMessages: { $sum: 1 }
                }
            },

            // 3. Lookup Metadata
            {
                $lookup: {
                    from: metadataCollectionName,
                    localField: "_id",
                    foreignField: "chatId",
                    as: "metadata"
                }
            },

            // 4. Unwind metadata (preserve null if missing)
            {
                $unwind: {
                    path: "$metadata",
                    preserveNullAndEmptyArrays: true
                }
            },

            // 4.5 Filter out soft-deleted chats
            {
                $match: {
                    "metadata.isDeleted": { $ne: true }
                }
            },

            // 5. Sort chats by pinned (descending), then last message time (descending)
            {
                $sort: {
                    "metadata.isPinned": -1,
                    "lastMessage.createdAt": -1
                }
            },

            // 6. Cap results to prevent resource exhaustion on large projects
            { $limit: 200 },

            // 7. Project fields
            {
                $project: {
                    chatId: "$_id",
                    lastMessage: 1,
                    unreadCount: 1,
                    totalMessages: 1,
                    metadata: 1,
                    _id: 0
                }
            }
        ];

        const chats = await MessageModel.aggregate(aggregationPipeline);

        // ── ASSIGNMENT-AWARE SORT ─────────────────────────────────────────────
        // Determine currentUserId early so we can use it for both sort and
        // unread filtering below. (Re-declared as const later — moved up here.)
        const currentUserId = req.supportUser?.id
            ? String(req.supportUser.id)
            : req.admin?.adminId
                ? String(req.admin.adminId)
                : null;
        const isAdmin = !!req.admin?.adminId ||
            req.supportUser?.role === 'ADMIN' ||
            req.supportUser?.role === 'admin';

        // Priority:
        //   0 = pinned (always top)
        //   1 = unassigned or assigned to me (active)
        //   2 = assigned to others, not resolved
        //   3 = resolved (always bottom)
        const getAssignmentPriority = (chat, uid) => {
            const meta = chat.metadata;
            if (meta?.isPinned) return 0;
            if (meta?.status === 'resolved') return 3;
            const assignedId = meta?.assignedTo ? String(meta.assignedTo) : null;
            const origId = (meta?.originalAssignedTo &&
                !['system', 'bot'].includes(String(meta.originalAssignedTo)))
                ? String(meta.originalAssignedTo) : null;
            const owner = assignedId ?? origId;
            if (!owner || owner === uid) return 1;    // unassigned OR mine
            return 2;                                // someone else's
        };

        if (currentUserId) {
            chats.sort((a, b) => {
                const pa = getAssignmentPriority(a, currentUserId);
                const pb = getAssignmentPriority(b, currentUserId);
                if (pa !== pb) return pa - pb;
                return new Date(b.lastMessage?.createdAt || 0).getTime()
                    - new Date(a.lastMessage?.createdAt || 0).getTime();
            });
        }
        // ─────────────────────────────────────────────────────────────────────

        // ── PER-USER UNREAD FILTERING ────────────────────────────────────────
        // Apply filtering for both admins and support users
        const processedChats = currentUserId
            ? await Promise.all(chats.map(async (chat) => {
                const role = isAdmin ? 'admin' : 'support';
                const accurateCount = await getChatUnreadCount(project, chat.chatId, currentUserId, role);
                return { ...chat, unreadCount: accurateCount };
            }))
            : chats;
        // ─────────────────────────────────────────────────────────────────────

        return res.status(200).json({
            success: true,
            chats: processedChats,
        });


    } catch (error) {
        console.error("getChats error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch chats",
        });
    }
};

// ==================== UPDATE CHAT STATUS ====================
/**
 * Update the status of a chat (e.g., mark as resolved)
 * PATCH /api/messages/project/:projectId/chat/:chatId/status
 */
export const updateChatStatus = async (req, res) => {
    try {
        const { projectId, chatId } = req.params;
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({ success: false, message: "Status is required" });
        }

        // Only 'resolved' can be set manually.
        // 'unresolved' is triggered exclusively by a new student message (auto-unresolve).
        if (status !== 'resolved') {
            return res.status(400).json({
                success: false,
                message: "Manual unresolve is not allowed. A chat can only be reopened when the student sends a new message.",
            });
        }

        const project = await Project.findOne({ projectId });
        if (!project) {
            return res.status(404).json({ success: false, message: "Project not found" });
        }

        const MetadataModel = getMetadataModel(project.collections.metadata);

        // Fetch existing metadata to check current status and resolver
        const metadata = await MetadataModel.findOne({ chatId });

        // Middleware sets req.supportUser for support agents, req.admin for admins
        let currentUserId = null;
        if (req.supportUser?.id) {
            currentUserId = String(req.supportUser.id);
        } else if (req.admin?.adminId) {
            currentUserId = String(req.admin.adminId);
        }

        // Robust admin check
        const isAdmin = !!req.admin?.adminId ||
            req.supportUser?.role === 'ADMIN' ||
            req.supportUser?.role === 'admin';

        // NEW: Only the currently active assignee (or admin) can resolve/unresolve
        if (!isAdmin && metadata) {
            const activeAssigneeId = metadata.assignedTo
                ? String(metadata.assignedTo)
                : (metadata.originalAssignedTo && !['system', 'bot'].includes(String(metadata.originalAssignedTo)) ? String(metadata.originalAssignedTo) : null);
            // If there's an active assignee and it's not the caller, block
            if (activeAssigneeId && activeAssigneeId !== currentUserId) {
                // Find out the assignee name for the error message
                let assigneeName = 'another support user';
                try {
                    const assigneeUser = await SupportUser.findById(activeAssigneeId).select('username email').lean();
                    assigneeName = assigneeUser?.username || assigneeUser?.email || assigneeName;
                } catch (e) {/* ignore */ }
                return res.status(403).json({
                    success: false,
                    message: `Only the assigned support user (${assigneeName}) can resolve or unresolve this chat.`
                });
            }
        }

        if (metadata && metadata.status === 'resolved' && status === 'resolved') {
            return res.status(200).json({ success: true, message: "Chat is already resolved" });
        }

        if (metadata && metadata.status === 'resolved' && !isAdmin) {
            // resolvedBy is now an array — use the last entry as the latest resolver
            const lastEntry = Array.isArray(metadata.resolvedBy) && metadata.resolvedBy.length > 0
                ? metadata.resolvedBy[metadata.resolvedBy.length - 1]
                : null;
            const originalResolverId = lastEntry?.userId ? String(lastEntry.userId) : null;
            if (originalResolverId && originalResolverId !== currentUserId) {
                return res.status(403).json({
                    success: false,
                    message: `Only the user who resolved this chat (${lastEntry.username || 'unknown'}) can unresolve it.`
                });
            }
        }

        // Calculate lastCycleIdx BEFORE update
        let lastCycleIdx = -1;
        if (metadata && metadata.helpCycles && metadata.helpCycles.length > 0) {
            lastCycleIdx = metadata.helpCycles.length - 1;
        }

        // Build the update payload - Always reset rating flags on status change (v9)
        const setPayload = {
            status,
            ratingRequested: false,
            pendingRatingCount: 0,
            reviewRequested: false
        };
        const pushPayload = {};

        if (status === 'resolved') {
            // Track who resolved and when — PUSH to array (never overwrites history)
            let resolverId = null;
            let resolverName = null;

            if (req.supportUser?.id) {
                resolverId = String(req.supportUser.id);
                resolverName = req.supportUser.username || req.supportUser.email || null;
            } else if (req.admin?.adminId) {
                resolverId = String(req.admin.adminId);
                resolverName = req.admin.username || req.admin.email || 'Admin';
            }

            // Calculate duration
            let durationStr = null;
            try {
                const MessageModel = getMessageModel(project.collections.messages);

                // Find the timestamp of the last resolution event (if any existed)
                let lastResolvedAt = null;
                if (metadata && Array.isArray(metadata.resolvedBy) && metadata.resolvedBy.length > 0) {
                    const lastEntry = metadata.resolvedBy[metadata.resolvedBy.length - 1];
                    if (lastEntry && lastEntry.resolvedAt) {
                        lastResolvedAt = new Date(lastEntry.resolvedAt);
                    }
                }

                // Find the first message sent AFTER the last resolution (i.e. when it was reopened),
                // OR the absolute first message if this chat has never been resolved before.
                // We specifically look for the first message from the STUDENT.
                const query = { chatId, senderType: 'student' };
                if (lastResolvedAt) {
                    query.createdAt = { $gt: lastResolvedAt };
                }

                const firstMsgSinceOpen = await MessageModel.findOne(query).sort({ createdAt: 1 }).lean();

                if (firstMsgSinceOpen && firstMsgSinceOpen.createdAt) {
                    const diffMs = Date.now() - new Date(firstMsgSinceOpen.createdAt).getTime();
                    const totalSec = Math.floor(diffMs / 1000);
                    const hours = Math.floor(totalSec / 3600);
                    const minutes = Math.floor((totalSec % 3600) / 60);
                    const seconds = totalSec % 60;

                    if (hours > 0) durationStr = `${hours}h ${minutes}m ${seconds}s`;
                    else if (minutes > 0) durationStr = `${minutes}m ${seconds}s`;
                    else durationStr = `${seconds}s`;
                }
            } catch (err) {
                console.error("Error calculating duration:", err);
            }

            pushPayload.resolvedBy = {
                userId: resolverId,
                username: resolverName,
                chatId,
                resolvedAt: new Date(),
                durationString: durationStr,
            };

            // Push current assistants to history, then clear active assistants
            if (metadata && metadata.assistants && metadata.assistants.length > 0) {
                pushPayload.assistantHistory = metadata.assistants;
                setPayload.assistants = [];
            }

            // Archive current originalAssignedTo into originalAssigneeHistory, then clear
            const origId = metadata?.originalAssignedTo || null;
            let origName = null;
            if (origId) {
                try {
                    let origAgent = await SupportUser.findById(origId).select('username email').lean();
                    if (!origAgent) origAgent = await Admin.findById(origId).select('username email').lean();
                    if (origAgent) origName = origAgent.username || origAgent.email || null;
                } catch (_) { }
            }
            const originalAssigneeEntry = origId
                ? [{ agentId: origId, agentName: origName, chatId, assignedAt: new Date() }]
                : [];
            if (originalAssigneeEntry.length > 0) {
                pushPayload.originalAssigneeHistory = originalAssigneeEntry;
            }

            // setPayload.pendingRatingCount = (metadata?.pendingRatingCount || 0) + 1;
        }
        if (status === 'resolved') {
            // setPayload.pendingRatingCount = (metadata?.pendingRatingCount || 0) + 1; // REMOVED: No auto-rating on resolve
            setPayload.ratingRequested = false;          // Always reset on resolve
            setPayload.pendingRatingCount = 0;            // Always reset on resolve
            setPayload.reviewRequested = false;           // Always reset on resolve
            setPayload["lastMessageDetails"] = null; // Clear the auto-resolve timer
            setPayload.assignedTo = null;           // ← clear so UI shows fresh chat
            setPayload.originalAssignedTo = null;   // ← clear so UI shows fresh chat
            if (!setPayload.assistants) setPayload.assistants = [];

            // Resolve the latest helpCycle ATOMICALLY
            if (lastCycleIdx !== -1) {
                setPayload[`helpCycles.${lastCycleIdx}.resolvedAt`] = pushPayload.resolvedBy.resolvedAt;
                setPayload[`helpCycles.${lastCycleIdx}.resolvedBy`] = pushPayload.resolvedBy.username || "Support Agent";
            }

            // ── GLOBAL NOTIFICATION CLEAR ──────────────────────────────────
            // Mark all student messages as 'seen' globally. This ensures that
            // for EVERY agent, the unread count for this student returns to 0
            // once the chat is closed.
            const MessageModel = getMessageModel(project.collections.messages);
            await MessageModel.updateMany(
                { chatId, senderType: 'student', status: { $ne: 'seen' } },
                { $set: { status: 'seen', readAt: new Date() } }
            );

            // NEUTRALIZE: Also clear any rating request messages so they don't linger in resolved chats
            await MessageModel.updateMany(
                { chatId, showRating: true },
                { $set: { showRating: false, isDeleted: true } }
            );
        }

        const queryOptions = { chatId };
        if (status === 'resolved') {
            queryOptions.status = { $ne: 'resolved' };
        }

        const updatedMetadata = await MetadataModel.findOneAndUpdate(
            queryOptions,
            {
                $set: setPayload,
                ...(Object.keys(pushPayload).length ? { $push: pushPayload } : {}),
            },
            { new: true, upsert: status !== 'resolved' }
        );

        if (!updatedMetadata) {
            if (status === 'resolved') {
                return res.status(200).json({ success: true, message: "Chat is already resolved" });
            }
            return res.status(404).json({ success: false, message: "Chat not found" });
        }

        // ── BROADCAST REAL-TIME STATUS CHANGE ──────────────────────────────
        // Emit to the entire project room so every connected support user
        // sees the resolve / unresolve instantly without refreshing.
        const io = req.app.get('io');
        if (io) {
            const statusChangePayload = {
                chatId,
                projectId,
                status,
                autoUnresolved: false,
            };

            // If resolving, explicitly include cleared fields for immediate UI reset
            if (status === 'resolved') {
                statusChangePayload.assignedTo = null;
                statusChangePayload.originalAssignedTo = null;
                statusChangePayload.assistants = [];
                statusChangePayload.pendingRatingCount = updatedMetadata.pendingRatingCount || 0;
                statusChangePayload.ratingRequested = updatedMetadata.ratingRequested || false;
                statusChangePayload.helpCycles = updatedMetadata.helpCycles;
                statusChangePayload.resolvedBy = updatedMetadata.resolvedBy;
            }

            const statusChangeToken = encryptMessage(JSON.stringify(statusChangePayload));
            const roomKey = `${projectId}_${chatId}`;

            // For Support UI (Dashboard)
            io.to(`project_${projectId}`).emit('chat_status_changed', { token: statusChangeToken });

            // For Support UI (Active Chat Screen)
            io.to(roomKey).emit('chat_status_updated', { token: statusChangeToken });

            // For Student Widget
            io.to(roomKey).emit('chat_status_changed', { token: statusChangeToken });

            // Invalidate dashboard stats for the resolver and the previously assigned agent
            // so their "Resolved" count updates immediately without a manual refresh
            const callerId = req.supportUser?.id || req.admin?.id;
            if (callerId) io.to(`user_${String(callerId)}`).emit('stats_invalidated');
            const prevAssignee = metadata?.assignedTo ? String(metadata.assignedTo) : null;
            if (prevAssignee && prevAssignee !== String(callerId)) {
                io.to(`user_${prevAssignee}`).emit('stats_invalidated');
            }
        }
        // ───────────────────────────────────────────────────────────────────

        // ── INSERT "RESOLVED CONVERSATION" SYSTEM MESSAGE ──────────────────
        // When the chat is marked resolved, save a system message so both
        // support users see a clear divider in the chat timeline.
        if (status === 'resolved') {
            const MessageModel = getMessageModel(project.collections.messages);

            // 1. Create the persistent database record that is safe for the support dashboard
            const resolvedMsg = await MessageModel.create({
                projectId,
                chatId,
                senderType: 'system',
                senderId: null,
                messageType: 'text',
                message: 'Resolved conversation', // Standard text for dashboards
                status: 'sent',
                showRating: false, // CRITICAL: Never trigger rating UI on resolution
                isDeleted: false
            });

            // 1b. Defensive Cleanup: Forcefully set showRating: false on ANY previous "Resolved" messages for this chat
            await MessageModel.updateMany(
                { chatId, message: { $regex: /resolved/i } },
                { $set: { showRating: false } }
            );

            if (io) {
                // Emit standard message to the project room (Support Dashboards)
                const baseMsgObj = { ...resolvedMsg.toObject(), _id: String(resolvedMsg._id) };
                const supportMsgToken = encryptMessage(JSON.stringify(baseMsgObj));
                io.to(`project_${projectId}`).emit('new_message', { token: supportMsgToken });

                // 2. Transmute the message strictly for the widget (Student side)
                const lastResolver = pushPayload.resolvedBy;
                const widgetText = lastResolver?.durationString
                    ? `Your chat is resolved in ${lastResolver.durationString}`
                    : `Your chat is resolved.`;

                const deterministicResolvedTime = lastResolver?.resolvedAt ? new Date(lastResolver.resolvedAt).getTime() : Date.now();

                const widgetMsgObj = {
                    ...baseMsgObj,
                    _id: `virtual_resolved_${chatId}_${deterministicResolvedTime}`,
                    message: widgetText,
                    showRating: false,
                    pendingRatingCount: 0 // FALLBACK: Confirm no rating is pending
                };
                const widgetMsgToken = encryptMessage(JSON.stringify(widgetMsgObj));
                // Only emit the duration message to student sockets in the room
                const roomName = `${projectId}_${chatId}`;
                const sockets = await io.in(roomName).fetchSockets();

                // 3. Emit force logout/cleanup event to student widget
                // This ensures their local storage is wiped so they must re-identify next time.
                const cleanupPayload = { chatId, projectId, action: 'clear_session' };
                const cleanupToken = encryptMessage(JSON.stringify(cleanupPayload));
                io.to(roomName).emit('chat_force_logout', { token: cleanupToken });

                sockets.forEach(s => {
                    if (s.user?.role === 'student') {
                        s.emit('new_message', { token: widgetMsgToken });
                    }
                });
            }
        }
        // ───────────────────────────────────────────────────────────────────

        return res.status(200).json({
            success: true,
            message: `Chat marked as ${status}`,
            metadata: updatedMetadata
        });

    } catch (error) {
        console.error("updateChatStatus error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update chat status",
        });
    }
};

/**
 * Soft delete a chat (hides from list) or permanent delete
 * DELETE /api/messages/project/:projectId/chat/:chatId?permanent=true
 */
export const deleteChat = async (req, res) => {
    try {
        const { projectId, chatId } = req.params;
        const { permanent } = req.query;

        const project = await Project.findOne({ projectId });
        if (!project) {
            return res.status(404).json({ success: false, message: "Project not found" });
        }

        const MessageModel = getMessageModel(project.collections.messages);
        const MetadataModel = getMetadataModel(project.collections.metadata);

        if (permanent === 'true') {
            // Permanently delete message data and metadata
            await Promise.all([
                MessageModel.deleteMany({ chatId }),
                MetadataModel.deleteOne({ chatId })
            ]);
        } else {
            // Soft delete: hide it
            await MetadataModel.findOneAndUpdate({ chatId }, { $set: { isDeleted: true } });
        }

        // Broadcast to all staff members
        const io = req.app.get("io");
        if (io) {
            const deletePayload = encryptMessage(JSON.stringify({
                chatId,
                projectId,
                permanent: permanent === 'true'
            }));
            io.to(`project_${projectId}`).emit('chat_deleted_updated', { token: deletePayload });
        }

        return res.status(200).json({
            success: true,
            message: `Chat ${permanent === 'true' ? 'permanently' : 'soft'} deleted successfully`
        });

    } catch (error) {
        console.error("deleteChat error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete chat",
        });
    }
};
// ==================== GET PROJECT UNREAD TOTAL ====================
/**
 * Get total unread messages for a project across all chats
 * GET /api/messages/project/:projectId/unread-total
 */
export const getProjectUnreadTotal = async (req, res) => {
    try {
        const { projectId } = req.params;

        if (!projectId) {
            return res.status(400).json({
                success: false,
                message: "Project ID is required",
            });
        }

        const result = await getProjectMessageModel(projectId);
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error,
            });
        }

        const MessageModel = result.model;
        const project = result.project;
        if (!project) {
            return res.status(404).json({ success: false, message: "Project not found" });
        }
        const MetadataModel = getMetadataModel(project.collections.metadata);

        // Get identifying info
        const userId = req.admin?.adminId || req.supportUser?.id;
        const role = req.admin ? 'admin' : 'support';

        // Use the same centralized logic as the sockets for perfectly synchronized counts
        const totalUnread = await getPersonalizedUnreadCount(project, userId, role);


        return res.status(200).json({
            success: true,
            totalUnread,
        });
    } catch (error) {
        console.error("getProjectUnreadTotal error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch project unread total",
        });
    }
};

// ==================== TOGGLE CHAT PIN ====================
/**
 * Toggle the pinned status of a chat
 * PATCH /api/messages/project/:projectId/chat/:chatId/pin
 */
export const toggleChatPin = async (req, res) => {
    try {
        const { projectId, chatId } = req.params;
        const { isPinned, duration } = req.body; // duration in hours; null/undefined = forever

        if (typeof isPinned === "undefined") {
            return res.status(400).json({ success: false, message: "isPinned is required" });
        }

        const project = await Project.findOne({ projectId });
        if (!project) {
            return res.status(404).json({ success: false, message: "Project not found" });
        }

        const MetadataModel = getMetadataModel(project.collections.metadata);

        const update = { isPinned };
        if (isPinned) {
            update.pinnedAt = new Date();
            if (duration) {
                const exp = new Date();
                exp.setHours(exp.getHours() + duration);
                update.pinExpiresAt = exp;
            } else {
                update.pinExpiresAt = null; // pinned forever
            }
        } else {
            // Unpinning — clear pin timestamps
            update.pinnedAt = null;
            update.pinExpiresAt = null;
        }

        const metadata = await MetadataModel.findOneAndUpdate(
            { chatId },
            { $set: update },
            { new: true, upsert: true }
        );

        // Broadcast to all staff members
        const io = req.app.get("io");
        if (io) {
            const pinPayload = encryptMessage(JSON.stringify({
                chatId,
                projectId,
                isPinned,
            }));
            io.to(`project_${projectId}`).emit('chat_pin_updated', { token: pinPayload });
        }

        return res.status(200).json({
            success: true,
            message: `Chat ${isPinned ? "pinned" : "unpinned"}`,
            metadata,
        });
    } catch (error) {
        console.error("toggleChatPin error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update chat pin status",
        });
    }
};
// ==================== GET CHAT OWNERSHIP INFO ====================
/**
 * Returns assignedTo, assistants, and resolvedBy with populated user details
 * GET /api/messages/project/:projectId/chat/:chatId/info
 */
export const getChatInfo = async (req, res) => {
    try {
        const { projectId, chatId } = req.params;

        const project = await Project.findOne({ projectId });
        if (!project) {
            return res.status(404).json({ success: false, message: "Project not found" });
        }

        const MetadataModel = getMetadataModel(project.collections.metadata);
        const metadata = await MetadataModel.findOne({ chatId }).lean();

        if (!metadata) {
            return res.status(200).json({
                success: true,
                assignedTo: null,
                assistants: [],
                resolvedBy: null,
                visitorInfo: null,
            });
        }

        // Populate assigned agent
        let assignedTo = null;
        if (metadata.assignedTo) {
            try {
                let agent = await SupportUser.findById(metadata.assignedTo).select('username email role').lean();
                if (!agent) {
                    agent = await Admin.findById(metadata.assignedTo).select('username email role').lean();
                    if (agent) agent.role = 'admin';
                }
                assignedTo = agent ? { _id: metadata.assignedTo, username: agent.username, email: agent.email, role: agent.role } : { _id: metadata.assignedTo, username: 'Unknown', email: null };
            } catch (_) {
                assignedTo = { _id: metadata.assignedTo, username: 'Unknown', email: null };
            }
        }

        // Populate each assistant
        const assistants = await Promise.all(
            (metadata.assistants || []).map(async (aid) => {
                try {
                    let agent = await SupportUser.findById(aid).select('username email role').lean();
                    if (!agent) {
                        agent = await Admin.findById(aid).select('username email role').lean();
                        if (agent) agent.role = 'admin';
                    }
                    return agent ? { _id: aid, username: agent.username, email: agent.email, role: agent.role } : { _id: aid, username: 'Unknown', email: null };
                } catch (_) {
                    return { _id: aid, username: 'Unknown', email: null };
                }
            })
        );

        // Visitor info
        const visitorInfo = {
            name: metadata.name,
            email: metadata.email,
            browser: metadata.browser,
            os: metadata.os,
            device: metadata.device,
            location: metadata.history?.[0]?.location || null,
            ip: metadata.history?.[0]?.ip || null,
        };

        // ── ORIGINAL ASSIGNEE LOGIC ─────────────────────────────────────────
        // We only backfill originalAssignedTo for older chats that don't have it.
        // If it's null because it was EXPLICITLY cleared (e.g. resolution), we
        // must NOT backfill it from history.
        let originalAssignedTo = null;
        let originalAgentId = metadata.originalAssignedTo;

        const hasHistory = (metadata.originalAssigneeHistory && metadata.originalAssigneeHistory.length > 0) ||
            (metadata.resolvedBy && metadata.resolvedBy.length > 0);

        if (!originalAgentId && !hasHistory && metadata.status !== 'resolved') {
            // Fallback: only for TRULY old/fresh chats without any history.
            try {
                const MessageModel = getMessageModel(project.collections.messages);
                const firstSupportMsg = await MessageModel.findOne({
                    chatId,
                    senderType: { $in: ['support', 'admin'] },
                    senderId: { $ne: null, $nin: ['system', 'bot'] }
                }).sort({ createdAt: 1 }).select('senderId').lean();

                if (firstSupportMsg) {
                    originalAgentId = String(firstSupportMsg.senderId);
                    await MetadataModel.updateOne({ chatId }, { $set: { originalAssignedTo: originalAgentId } });
                }
            } catch (fallbackErr) {
                console.error('originalAssignedTo fallback error:', fallbackErr);
            }
        }

        if (originalAgentId) {
            try {
                let og = await SupportUser.findById(originalAgentId).select('username email role').lean();
                if (!og) {
                    og = await Admin.findById(originalAgentId).select('username email role').lean();
                    if (og) og.role = 'admin';
                }
                originalAssignedTo = og
                    ? { _id: originalAgentId, username: og.username, email: og.email, role: og.role }
                    : { _id: originalAgentId, username: 'Unknown', email: null };
            } catch (_) {
                originalAssignedTo = { _id: originalAgentId, username: 'Unknown', email: null };
            }
        }

        // Build resolvedBy data — now an array; most recent entry = last element
        const resolvedByArray = metadata.resolvedBy || [];
        const latestResolvedBy = resolvedByArray.length > 0 ? resolvedByArray[resolvedByArray.length - 1] : null;

        // Populate names for transfer history
        const populatedTransferHistory = await Promise.all(
            (metadata.transferHistory || [[]]).map(async (session) => {
                return await Promise.all(
                    (session || []).map(async (t) => {
                        const populated = { ...t };
                        if (t.fromId) {
                            let f = await SupportUser.findById(t.fromId).select('username email').lean();
                            if (!f) f = await Admin.findById(t.fromId).select('username email').lean();
                            populated.fromName = f?.username || 'Unknown';
                            populated.fromEmail = f?.email || null;
                        }
                        if (t.toId) {
                            let tU = await SupportUser.findById(t.toId).select('username email').lean();
                            if (!tU) tU = await Admin.findById(t.toId).select('username email').lean();
                            populated.toName = tU?.username || 'Unknown';
                            populated.toEmail = tU?.email || null;
                        }
                        return populated;
                    })
                );
            })
        );

        return res.status(200).json({
            success: true,
            // If assignedTo is null but we have an originalAssignedTo (e.g. backfilled from messages),
            // use it as assignedTo too so the UI shows someone is assigned
            assignedTo: assignedTo || originalAssignedTo,
            originalAssignedTo,
            assistants,
            rejectedBy: metadata.rejectedBy || [],
            pendingTransfer: metadata.pendingTransfer || null,
            // resolvedBy: most recent resolution (for backwards-compat UI fallback)
            resolvedBy: latestResolvedBy?.userId ? latestResolvedBy : null,
            // Full history arrays
            resolvedByHistory: resolvedByArray,
            transferHistory: populatedTransferHistory,
            currentSessionTransfers: populatedTransferHistory[populatedTransferHistory.length - 1] || [],
            visitorInfo,
            helpCycles: metadata.helpCycles || [],
        });

    } catch (error) {
        console.error("getChatInfo error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch chat info" });
    }
};

// ==================== SUBMIT CHAT RATING ====================
export const submitChatRating = async (req, res) => {
    try {
        const { projectId, chatId } = req.params;
        const { rating } = req.body;


        if (!projectId || !chatId || rating === undefined) {
            return res.status(400).json({ success: false, message: "Missing required fields." });
        }

        // Security Check: Only the student associated with this chat can submit a rating
        if (req.userType !== 'student' || !req.student) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized: Only the valid student participant can rate this chat.",
            });
        }

        if (req.student.chatId !== chatId || req.student.projectId !== projectId) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized: Only the valid student participant can rate this chat.",
            });
        }

        const numericRating = Number(rating);
        if (isNaN(numericRating) || numericRating < 1 || numericRating > 5) {
            return res.status(400).json({ success: false, message: "Rating must be a number between 1 and 5." });
        }

        const project = await Project.findOne({ projectId });
        if (!project) {
            return res.status(404).json({ success: false, message: "Project not found" });
        }

        const MetadataModel = getMetadataModel(project.collections.metadata);

        // Find the metadata for this chat
        const metadata = await MetadataModel.findOne({ chatId });
        if (!metadata) {
            return res.status(404).json({ success: false, message: "Chat metadata not found." });
        }

        // Guard: rating must have been explicitly requested by support for this session
        if (!metadata.ratingRequested) {
            // Because the frontend widget does not dynamically vanish if it encounters an error, 
            // returning a 400 here causes the UI to freeze with an error message indefinitely.
            // We silently return 200 OK so the widget receives its 'success' flag and successfully destroys the UI card.
            return res.status(200).json({
                success: true,
                message: "Rating submitted successfully.",
                data: { rating: numericRating }
            });
        }

        // Guard: If the chat is resolved, do not accept the rating (as per once-per-cycle requirement)
        if (metadata.status === 'resolved') {
            return res.status(200).json({
                success: true,
                message: "Chat resolved. Rating not accepted.",
                data: { rating: numericRating }
            });
        }

        // Identify the agent associated with the resolution (if any)
        let resolverId = null;
        if (metadata.resolvedBy && metadata.resolvedBy.length > 0) {
            const lastIndex = metadata.resolvedBy.length - 1;
            resolverId = metadata.resolvedBy[lastIndex]?.userId || null;
        }

        // Identify the assigned support agent
        let assignedId = metadata.assignedTo || metadata.originalAssignedTo || null;
        let assignedUsername = "Unknown";

        // Fallback: If chat is already resolved, get the last resolver from resolvedBy array
        if (!assignedId && metadata.resolvedBy && metadata.resolvedBy.length > 0) {
            const lastResolve = metadata.resolvedBy[metadata.resolvedBy.length - 1];
            assignedId = lastResolve.userId;
            assignedUsername = lastResolve.username || "Support Agent";
        }

        // Use resolverId as the primary agent ID; fall back to current assignee
        const effectiveAgentId = resolverId || assignedId;

        if (effectiveAgentId && assignedUsername === "Unknown") {
            try {
                let agent = await SupportUser.findById(effectiveAgentId).select('username').lean();
                if (!agent) {
                    agent = await Admin.findById(effectiveAgentId).select('username').lean();
                }
                if (agent) {
                    assignedUsername = agent.username;
                }
            } catch (err) {
                console.error("Error fetching agent username for rating:", err);
            }
        }

        // Store the rating in the new ratings array
        if (!metadata.ratings) {
            metadata.ratings = [];
        }

        metadata.ratings.push({
            rating: numericRating,
            chatId: chatId,
            userId: effectiveAgentId,
            username: assignedUsername,
            ratedAt: new Date()
        });

        // Always store in latestRating so it's accessible regardless of resolve state
        metadata.latestRating = numericRating;

        // Reset the request flag and pending count
        metadata.ratingRequested = false;
        metadata.pendingRatingCount = Math.max(0, (metadata.pendingRatingCount || 1) - 1);

        // Save the updated metadata
        await metadata.save();

        // Emit socket events to update support UI
        const io = req.app.get('io');
        // (Moved emission to end of block to prevent race conditions)
        // Broad cleanup: Find ALL previous rating request messages and disable them
        const MessageModel = getMessageModel(project.collections.messages);
        const oldMessages = await MessageModel.find({ chatId, showRating: true });

        await MessageModel.updateMany(
            { chatId, showRating: true },
            { $set: { showRating: false, isDeleted: true } }
        );

        // Create a system message so the UI knows a rating was submitted
        const systemMessage = new MessageModel({
            projectId,
            chatId,
            senderType: 'system',
            message: `Rating from student: ${numericRating} stars`,
            messageType: 'text',
            status: 'sent',
            isHidden: false, // SHOWN: This helps the widget refresh its message list
        });
        await systemMessage.save();

        // Emit socket event to update the chat UI in real-time
        if (io) {
            const roomKey = `${projectId}_${chatId}`;

            // 1) Mark all old cards as deleted/updated in frontend memory
            for (const oldMsg of oldMessages) {
                const updatedMsg = { ...oldMsg.toObject(), showRating: false, isDeleted: true };
                const updatedToken = encryptMessage(JSON.stringify(updatedMsg));
                io.to(roomKey).emit("message_updated", { token: updatedToken });

                const deleteToken = encryptMessage(JSON.stringify({
                    chatId: oldMsg.chatId,
                    projectId: oldMsg.projectId,
                    messageId: String(oldMsg._id),
                    isDeleted: true
                }));
                io.to(roomKey).emit("message_deleted", { token: deleteToken });
            }

            // 2) Append the new success text text
            const msgToken = encryptMessage(JSON.stringify(systemMessage));
            io.to(roomKey).emit("new_message", { token: msgToken });

            // 3) Broadcast metadata change to unlock Support Screen input
            const metaToken = encryptMessage(JSON.stringify(metadata));
            io.to(roomKey).emit("chat_status_updated", { token: metaToken });
            io.to(roomKey).emit("chat_status_changed", { token: metaToken });
            io.to(`project_${projectId}`).emit("chat_status_updated", { token: metaToken });

            // 4) Stats Invalidation
            const resolvedCount = metadata.resolvedBy?.length || 0;
            if (resolvedCount > 0) {
                const lastIndex = resolvedCount - 1;
                const resolverId = metadata.resolvedBy[lastIndex]?.userId;
                if (resolverId) io.to(`user_${String(resolverId)}`).emit('stats_invalidated');
            } else if (assignedId) {
                io.to(`user_${String(assignedId)}`).emit('stats_invalidated');
            }
        }

        return res.status(200).json({
            success: true,
            message: "Rating submitted successfully.",
            data: {
                rating: numericRating,
                chatId,
                status: 'success'
            }
        });

    } catch (error) {
        console.error("Error submitting chat rating:", error);
        res.status(500).json({ success: false, message: "Failed to submit rating." });
    }
};

// ==================== GET SUPPORT USER PUBLIC INFO ====================
/**
 * Returns non-sensitive info for a support user (for message info panel)
 * GET /api/support-users/:userId/public-info  -- registered in supportUserRoutes.js
 * We also export it here so messageRoutes can re-use if needed.
 */
export const getSupportUserPublicInfo = async (req, res) => {
    try {
        const { userId } = req.params;

        // Handle special system/bot IDs
        if (userId === "system" || userId === "bot") {
            return res.status(200).json({
                success: true,
                user: { _id: userId, username: userId.charAt(0).toUpperCase() + userId.slice(1), role: "system" }
            });
        }

        const user = await SupportUser.findById(userId).select('username email role').lean();
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }
        return res.status(200).json({ success: true, user });
    } catch (error) {
        console.error("getSupportUserPublicInfo error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch user info" });
    }
};

// ==================== TOGGLE MESSAGE REACTION ====================
/**
 * Add or remove a reaction to a message
 * POST /api/messages/:projectId/:chatId/:messageId/reaction
 */
export const toggleMessageReaction = async (req, res) => {
    try {
        const { projectId, chatId, messageId } = req.params;
        const { emoji, senderId, senderType } = req.body;

        if (!projectId || !messageId || !emoji || !senderId || !senderType) {
            return res.status(400).json({
                success: false,
                message: "Missing required fields for reaction",
            });
        }

        const result = await getProjectMessageModel(projectId);
        if (!result.success) {
            return res.status(404).json({
                success: false,
                message: result.error,
            });
        }

        const MessageModel = result.model;

        const message = await MessageModel.findById(messageId);
        if (!message) {
            return res.status(404).json({ success: false, message: "Message not found" });
        }

        // Check if user already reacted
        const existingReactionIndex = message.reactions?.findIndex(
            (r) => String(r.senderId) === String(senderId)
        );

        let action = 'added';

        if (existingReactionIndex !== -1 && existingReactionIndex !== undefined) {
            // User already reacted
            if (message.reactions[existingReactionIndex].emoji === emoji) {
                // If same emoji, remove it
                message.reactions.splice(existingReactionIndex, 1);
                action = 'removed';
            } else {
                // Different emoji, change it
                message.reactions[existingReactionIndex].emoji = emoji;
                message.reactions[existingReactionIndex].createdAt = new Date();
                action = 'updated';
            }
        } else {
            // New reaction
            if (!message.reactions) message.reactions = [];
            message.reactions.push({ emoji, senderId, senderType });
        }

        await message.save();
        const updatedMessageObject = message.toObject();

        if (updatedMessageObject.fileUrl) {
            updatedMessageObject.fileUrl = await signUrl(updatedMessageObject.fileUrl);
        }

        // Broadcast to clients
        const io = req.app.get("io");
        if (io) {
            const roomKey = `${projectId}_${chatId}`;
            const token = encryptMessage(JSON.stringify(updatedMessageObject));
            io.to(roomKey).emit("message_updated", { token }); // Let clients handle it like a normal update
        }

        return res.status(200).json({
            success: true,
            action,
            data: updatedMessageObject,
        });
    } catch (error) {
        console.error("toggleMessageReaction error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to toggle reaction",
        });
    }
};

// ==================== REQUEST CHAT RATING ====================
/**
 * Support user requests a rating from the student
 * POST /api/messages/project/:projectId/chat/:chatId/request-rating
 */
export const requestChatRating = async (req, res) => {
    try {
        const { projectId, chatId } = req.params;

        // 1. Load project and models
        const project = await Project.findOne({ projectId });
        if (!project) {
            return res.status(404).json({ success: false, message: "Project not found" });
        }

        const MetadataModel = getMetadataModel(project.collections.metadata);
        const MessageModel = getMessageModel(project.collections.messages);

        // 2. Fetch metadata
        let metadata = await MetadataModel.findOne({ chatId });
        if (!metadata) {
            return res.status(404).json({ success: false, message: "Chat metadata not found" });
        }

        // 3. Validation: Rating can ONLY be requested if the chat is ACTIVE (not resolved).
        if (metadata.status === 'resolved') {
            return res.status(400).json({
                success: false,
                message: "Cannot request rating for a resolved chat. Please request it during an active conversation."
            });
        }

        // 3b. Assigned Agent Restriction: Only the assigned agent can request the rating.
        const requesterId = req.supportUser?.id || req.supportUser?._id || req.admin?.adminId;
        if (metadata.assignedTo && requesterId && String(metadata.assignedTo) !== String(requesterId)) {
            return res.status(403).json({
                success: false,
                message: "Only the assigned agent can request a rating for this chat."
            });
        }

        if (metadata.ratingRequested) {
            return res.status(400).json({ success: false, message: "Rating already requested for this session." });
        }

        // Has a rating already been given in the CURRENT session?
        let lastResolvedAt = null;
        if (metadata.resolvedBy && metadata.resolvedBy.length > 0) {
            const lastResolver = metadata.resolvedBy[metadata.resolvedBy.length - 1];
            if (lastResolver && lastResolver.resolvedAt) {
                lastResolvedAt = new Date(lastResolver.resolvedAt);
            }
        }

        const hasRatedInSession = metadata.ratings && metadata.ratings.some(r => {
            if (!lastResolvedAt) return true; // Never resolved, so any rating is in current session
            return new Date(r.ratedAt) > lastResolvedAt;
        });

        if (hasRatedInSession) {
            return res.status(400).json({ success: false, message: "A rating has already been submitted for this chat session." });
        }

        // Ensure there's interaction (student messaged and support replied)
        const lastCycle = metadata.helpCycles && metadata.helpCycles.length > 0
            ? metadata.helpCycles[metadata.helpCycles.length - 1]
            : null;

        if (!lastCycle || !lastCycle.startedAt || !lastCycle.pickedUpAt) {
            return res.status(400).json({
                success: false,
                message: "A rating can only be requested after the support user has replied to a student message."
            });
        }

        // 4. Update Metadata atomically - prevents race conditions
        const updateResult = await MetadataModel.findOneAndUpdate(
            { chatId, ratingRequested: false },
            { $set: { ratingRequested: true, pendingRatingCount: 1 } },
            { new: true }
        );

        if (!updateResult) {
            return res.status(400).json({
                success: false,
                message: "Rating already requested for this session."
            });
        }

        // Use the updated metadata for subsequent operations
        metadata = updateResult;

        // 5. Clear any existing rating request messages (defensive cleanup)
        // In case there are old messages with showRating: true still lingering
        await MessageModel.updateMany(
            { chatId, showRating: true },
            { $set: { showRating: false } }
        );

        // 6. Create System Message
        // The widget looks for specific text or flags to show the rating UI.
        const systemMessage = new MessageModel({
            projectId,
            chatId,
            senderType: 'system',
            message: "Support has requested a rating",
            showRating: true, // This flag triggers the UI in the widget
            isHidden: false, // SHOWN: So the widget "sees" it correctly
        });
        await systemMessage.save();

        // 7. Emit Sockets
        const io = req.app.get("io");
        if (io) {
            const roomKey = `${projectId}_${chatId}`;
            // For Support UI (to disable "Request Rating" button)
            const metaToken = encryptMessage(JSON.stringify(metadata));
            io.to(roomKey).emit("chat_status_updated", { token: metaToken });

            // For Student Widget: emit chat_status_changed (which the widget listens to)
            // so it IMMEDIATELY disables the input before the new_message even arrives.
            const ratingStatusPayload = {
                chatId,
                projectId,
                status: metadata.status,
                pendingRatingCount: metadata.pendingRatingCount || 1,
                ratingRequested: true
            };
            const ratingStatusToken = encryptMessage(JSON.stringify(ratingStatusPayload));
            io.to(roomKey).emit("chat_status_changed", { token: ratingStatusToken });

            // For Student Widget (to render the rating UI card)
            const msgToken = encryptMessage(JSON.stringify(systemMessage));
            io.to(roomKey).emit("new_message", { token: msgToken });
        }

        return res.status(200).json({
            success: true,
            message: "Rating requested successfully",
            data: { ratingRequested: true }
        });

    } catch (error) {
        console.error("requestChatRating error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to request chat rating",
        });
    }
};

// ==================== REQUEST CHAT REVIEW ====================
/**
 * Support user requests a review from the student
 * POST /api/messages/project/:projectId/chat/:chatId/request-review
 */
export const requestChatReview = async (req, res) => {
    try {
        const { projectId, chatId } = req.params;

        // 1. Load project and models
        const project = await Project.findOne({ projectId });
        if (!project) {
            return res.status(404).json({ success: false, message: "Project not found" });
        }

        const MetadataModel = getMetadataModel(project.collections.metadata);
        const MessageModel = getMessageModel(project.collections.messages);

        // 2. Fetch metadata
        let metadata = await MetadataModel.findOne({ chatId });
        if (!metadata) {
            return res.status(404).json({ success: false, message: "Chat metadata not found" });
        }

        // 3. Validation: Review can ONLY be requested if the chat is ACTIVE (not resolved).
        if (metadata.status === 'resolved') {
            return res.status(400).json({
                success: false,
                message: "Cannot request review for a resolved chat."
            });
        }

        if (metadata.reviewRequested) {
            return res.status(400).json({ success: false, message: "Review already requested for this session." });
        }

        // 4. Update Metadata atomically
        const updateResult = await MetadataModel.findOneAndUpdate(
            { chatId },
            { $set: { reviewRequested: true } },
            { new: true }
        );

        if (!updateResult) {
            return res.status(400).json({
                success: false,
                message: "Failed to update review status."
            });
        }

        // 5. Create the Review Message from Support
        // We send it as a regular support message so it looks personal
        const requesterId = req.supportUser?.id || req.supportUser?._id || req.admin?.adminId;
        const reviewMessageText = project.reviewConfig?.message;
        if (!reviewMessageText || reviewMessageText.trim() === "") {
            return res.status(400).json({
                success: false,
                message: "No review message configured for this product. Please set it in Admin Settings."
            });
        }

        const reviewMessage = new MessageModel({
            projectId,
            chatId,
            senderType: 'support',
            senderId: requesterId,
            messageType: 'text',
            message: reviewMessageText,
            status: "sent",
        });

        await reviewMessage.save();

        // 6. Emit Sockets
        const io = req.app.get("io");
        if (io) {
            const roomKey = `${projectId}_${chatId}`;

            // For Support UI (to disable buttons or show status)
            const metaToken = encryptMessage(JSON.stringify(updateResult));
            io.to(roomKey).emit("chat_status_updated", { token: metaToken });

            // For Student/Support Widget (the actual message)
            const msgToken = encryptMessage(JSON.stringify(reviewMessage));
            io.to(roomKey).emit("new_message", { token: msgToken });
        }

        return res.status(200).json({
            success: true,
            message: "Review requested successfully",
            data: { reviewRequested: true }
        });

    } catch (error) {
        console.error("requestChatReview error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to request chat review",
        });
    }
};
