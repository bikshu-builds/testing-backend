import { getMessageModel } from "../model/dynamic/messageModel.js";
import { getMetadataModel } from "../model/dynamic/metadataModel.js";
import { getChatUnreadCount, getPersonalizedUnreadCount } from "../utils/unreadCounts.js";
import Project from "../model/project.js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import s3Client from "../config/s3.js";
import { encryptMessageCBC as encryptMessage, decryptMessage } from "../utils/messageEncryption.js";
import { verifyJWE, generateStudentJWE } from "../utils/jwt.js";
import SupportUser from "../model/supportUser.js";
import Admin from "../model/Admin.js";
import Notification from "../model/Notification.js";
import { sendFCMMessage } from "../utils/fcmService.js";
import { sendWebNotification } from "../utils/fcmServiceWeb.js";
import { resolveChat } from "../utils/autoResolveChats.js";

// Per-chat exact auto-resolve timers: { chatId => timeoutId }
const resolveTimeouts = new Map();


// ==================== HELPER FUNCTIONS
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Notify a specific support/admin user that their dashboard stats need refreshing.
 * The frontend listens to 'stats_invalidated' on its personal room (user_${userId})
 * and immediately re-fetches stats from the HTTP API.
 */
const emitStatsInvalidated = (io, userId) => {
    if (!userId) return;
    io.to(`user_${String(userId)}`).emit('stats_invalidated');
};



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

// Store active users: { userId: socketId }
const activeUsers = new Map();

// Store user rooms: { socketId: { projectId, chatId, userType, userId } }
const userRooms = new Map();

// Count of active connections per chatId: { chatId: Set<socketId> }
const chatConnections = new Map();

// ── Socket Rate Limiter (rolling-window token bucket per socket) ────────────
// Allows short human bursts but blocks bots that flood send_message.
const MESSAGE_RATE_LIMIT = 5;     // max messages allowed in the window
const MESSAGE_RATE_WINDOW_MS = 5000; // 5-second rolling window
const socketMessageTimestamps = new Map(); // socketId → number[]
// ────────────────────────────────────────────────────────────────────────────

// ── Socket Auth Failure Rate Limiter (per IP) ────────────────────────────────
// Mirrors the REST loginLimiter: blocks IPs that repeatedly fail JWE verification.
// This prevents credential-stuffing attacks against the socket auth layer.
const AUTH_FAIL_LIMIT = 10;              // max failures before lockout
const AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000; // 15-minute rolling window
const socketAuthFailures = new Map();    // ip → number[] of failure timestamps
// ─────────────────────────────────────────────────────────────────────────────

// ── Message length cap ────────────────────────────────────────────────────────
// Prevents resource-exhaustion attacks via very large text messages.
const MAX_MESSAGE_LENGTH = 5000; // characters
// ─────────────────────────────────────────────────────────────────────────────


export const setupSocketHandlers = (io) => {

    // ==================== SOCKET AUTH MIDDLEWARE ====================
    // HIGH-02: Verify JWT on connection for admin/support users
    // Students (widget users) connect without JWT but are restricted to student actions
    io.use(async (socket, next) => {
        const token = socket.handshake.auth?.token;
        if (token) {
            // ── Auth-failure rate limit check (per IP) ───────────────────────
            const ip = socket.handshake.address;
            const now = Date.now();
            const recentFailures = (socketAuthFailures.get(ip) || [])
                .filter(t => now - t < AUTH_FAIL_WINDOW_MS);

            if (recentFailures.length >= AUTH_FAIL_LIMIT) {
                return next(new Error("TOO_MANY_AUTH_FAILURES"));
            }
            // ─────────────────────────────────────────────────────────────────

            try {
                const decoded = await verifyJWE(token);
                // Check if it's a support user
                if (decoded.id) {
                    const user = await SupportUser.findById(decoded.id);
                    if (user && user.isActive) {
                        socket.user = { id: decoded.id, role: 'support', verified: true };
                    } else {
                        // Record failure for this IP
                        recentFailures.push(now);
                        socketAuthFailures.set(ip, recentFailures);
                        return next(new Error("INVALID_USER"));
                    }
                } else if (decoded.adminId) {
                    socket.user = { id: decoded.adminId, role: 'admin', verified: true };
                } else {
                    // Record failure for this IP
                    recentFailures.push(now);
                    socketAuthFailures.set(ip, recentFailures);
                    return next(new Error("INVALID_TOKEN"));
                }

                // Successful auth — clear the failure record for this IP
                socketAuthFailures.delete(ip);
            } catch (err) {
                // Record failure for this IP
                recentFailures.push(now);
                socketAuthFailures.set(ip, recentFailures);
                return next(new Error("AUTH_FAILED"));
            }
        } else {
            // No token = student/widget user (allowed but marked as unverified)
            socket.user = { role: 'student', verified: false };
        }
        next();
    });

    io.on("connection", (socket) => {

        // ==================== STRICT ENCRYPTION MIDDLEWARE ====================
        // Intercepts every incoming packet to enforce encryption and decrypt payload
        socket.use((packet, next) => {
            const [event, data] = packet;

            // Skip validation for events that might not return data (e.g. disconnect)
            // But disconnect is not "emitted" by client in the same way? Socket.io handles it.
            // Client emits custom events.
            if (!data) return next();

            if (!data.token) {
                console.error(`⛔ Rejected unencrypted event: ${event} from ${socket.id}. Error: All socket data must be sent as an encrypted 'token' property. Received plain data:`, JSON.stringify(data));
                return next(new Error("ENCRYPTION_REQUIRED"));
            }


            try {
                const decryptedJSON = decryptMessage(data.token);

                // Integrity Check: strict requirement for IV-based encryption
                if (decryptedJSON === data.token && data.token.includes(':') === false) {
                    // It wasn't encrypted format
                    return next(new Error("ENCRYPTION_REQUIRED"));
                }

                // Replace the encrypted data with the decrypted payload
                packet[1] = JSON.parse(decryptedJSON);
                next();
            } catch (e) {
                console.error(`❌ Failed to decrypt/parse ${event}:`, e.message);
                return next(new Error("INVALID_ENCRYPTED_PAYLOAD"));
            }
        });

        // Register support/admin users in activeUsers map immediately on connection
        // Also join a personal room so transfer_request always reaches them regardless of active chat
        if (socket.user && socket.user.id) {
            activeUsers.set(String(socket.user.id), socket.id);
            socket.join(`user_${String(socket.user.id)}`);
        }


        // ==================== USER JOINS CHAT ====================
        socket.on("join_chat", async (payload) => {
            // payload is now DECRYPTED by middleware
            const { projectId, chatId, userId, userType, isExplicitRestore, metadata } = payload;
            let sessionInfoForMemory = null;
            try {
                // Validate required fields
                if (!projectId || !chatId || !userType) {
                    socket.emit("error", { message: "Missing required fields" });
                    return;
                }

                // --- ROLE VERIFICATION ---
                // If the client claims to be a support agent or admin, 
                // ensure the socket connection was actually authenticated 
                // via a valid JWE token during the handshake.
                if ((userType === "support" || userType === "admin") && (!socket.user || !socket.user.verified || socket.user.role !== userType)) {
                    console.warn(`[SECURITY] Impersonation attempt blocked! User claimed to be ${userType} but is not authenticated in project ${projectId}.`);
                    socket.emit("error", { message: "Unauthorized: Invalid role" });
                    return;
                }
                // -------------------------

                // --- ROLE VERIFICATION ---
                // If the client claims to be a support agent or admin, 
                // ensure the socket connection was actually authenticated 
                // via a valid JWE token during the handshake.
                if ((userType === "support" || userType === "admin") && (!socket.user || !socket.user.verified || socket.user.role !== userType)) {
                    console.warn(`[SECURITY] Impersonation attempt blocked! User claimed to be ${userType} but is not authenticated in project ${projectId}.`);
                    socket.emit("error", { message: "Unauthorized: Invalid role" });
                    return;
                }
                // -------------------------

                // If it's a student (visitor) joining, validate and save metadata
                if (userType === "student") {
                    try {
                        const project = await Project.findOne({ projectId });

                        if (!project) {
                            socket.emit("error", { message: "Project not found" });
                            return;
                        }

                        // Check if email collection is enabled for this project
                        const emailSettings = project.emailSetting || {};

                        // Note: We no longer block join_chat if email is missing
                        // Email will be collected after the first message via inline prompt

                        // If email is provided during join, validate it
                        if (metadata?.email && typeof metadata.email === 'string' && metadata.email.trim() !== '') {
                            const trimmedEmail = metadata.email.toLowerCase().trim();
                            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                            if (!emailRegex.test(trimmedEmail)) {
                                socket.emit("error", {
                                    message: "Please enter a valid email address",
                                    code: "INVALID_EMAIL"
                                });
                                return;
                            }
                        }

                        if (project.collections?.metadata) {
                            const MetadataModel = getMetadataModel(project.collections.metadata);

                            const sessionInfo = {
                                ip: metadata?.ip || socket.handshake.address || null,
                                location: metadata?.location || null,
                                isp: metadata?.isp || null,
                                browser: metadata?.browser || null,
                                os: metadata?.os || null,
                                device: metadata?.device || null,
                                screenResolution: metadata?.screenResolution || null,
                                language: metadata?.language || null,
                                referrer: metadata?.referrer || null,
                                currentUrl: metadata?.currentUrl || null,
                                timestamp: new Date()
                            };

                            const metadataUpdate = {
                                projectId,
                                chatId,
                                userId,
                                emailSkipped: metadata?.emailSkipped || false,
                                // Keep latest session info at top level for quick access
                                ...sessionInfo
                            };

                            // Only update email/name if they are NOT null/empty in the payload
                            // This prevents overwriting existing data if local storage is cleared
                            if (metadata?.email) metadataUpdate.email = metadata.email.toLowerCase().trim();
                            if (metadata?.name) metadataUpdate.name = metadata.name.trim();

                            // Only create (upsert) metadata if they provided an email/name, or if the metadata already exists.
                            // This prevents creating thousands of empty duplicate metadata rows for visitors who never actually chat.
                            const updateOp = { $set: metadataUpdate, $push: { history: sessionInfo } };
                            sessionInfoForMemory = sessionInfo;

                            let currentMeta = await MetadataModel.findOne({ chatId });

                            // If they are returning to a chat that was already resolved, 
                            // we previously kicked them. NOW we allow them to join so 
                            // they can see their history, but we immediately emit 
                            // chat_status_changed so the UI locks down correctly.
                            if (currentMeta) {
                                if (currentMeta.status === 'resolved') {
                                    const statusPayload = {
                                        chatId, projectId,
                                        status: 'resolved',
                                        pendingRatingCount: currentMeta.pendingRatingCount || 0,
                                        ratingRequested: currentMeta.ratingRequested || false
                                    };
                                    const statusToken = encryptMessage(JSON.stringify(statusPayload));
                                    setTimeout(() => {
                                        socket.emit('chat_status_changed', { token: statusToken });
                                    }, 500);

                                    // ── AUTO-RESOLVE STORAGE FIX ──
                                    // If they are an offline user returning (implicit reconnect), wipe storage instantly 
                                    // so they start a new session. If they explicitly entered their email to see history, let them stay.
                                    if (!isExplicitRestore) {
                                        const cleanupPayload = { chatId, projectId, action: 'clear_session' };
                                        const cleanupToken = encryptMessage(JSON.stringify(cleanupPayload));
                                        socket.emit('chat_force_logout', { token: cleanupToken });
                                    }
                                } else if ((currentMeta.pendingRatingCount || 0) > 0 || currentMeta.ratingRequested) {
                                    // Unresolved but rating is pending — tell widget to block input
                                    const statusPayload = {
                                        chatId, projectId,
                                        status: currentMeta.status,
                                        pendingRatingCount: currentMeta.pendingRatingCount || 0,
                                        ratingRequested: currentMeta.ratingRequested || false
                                    };
                                    const statusToken = encryptMessage(JSON.stringify(statusPayload));
                                    setTimeout(() => {
                                        socket.emit('chat_status_changed', { token: statusToken });
                                    }, 500);
                                }
                            }

                            if (metadata?.email || metadata?.name) {
                                // If they explicitly provided info, we upsert so it's captured
                                await MetadataModel.findOneAndUpdate({ chatId }, updateOp, { upsert: true, new: true, setDefaultsOnInsert: true });
                            } else {
                                // Otherwise, only update IF it already exists (meaning they already started a chat)
                                await MetadataModel.findOneAndUpdate({ chatId }, updateOp, { new: true });
                            }


                        }
                    } catch (err) {
                        console.error("Error saving metadata:", err);
                        socket.emit("error", {
                            message: "Failed to save user information",
                            code: "METADATA_SAVE_FAILED"
                        });
                        return;
                    }
                }

                // Store user info
                const roomKey = `${projectId}_${chatId}`;
                socket.join(roomKey);

                activeUsers.set(userId || socket.id, socket.id);
                userRooms.set(socket.id, { projectId, chatId, userType, userId, initialSessionInfo: sessionInfoForMemory });

                // Removed automatic chat assignment on join. Assignment now only happens when an agent sends a message.

                // Notify others in the room
                const userJoinedPayload = {
                    userId: userId || socket.id,
                    userType,
                    timestamp: new Date(),
                };
                const userJoinedToken = encryptMessage(JSON.stringify(userJoinedPayload));
                socket.to(roomKey).emit("user_joined", { token: userJoinedToken });

                // Broadcast status update to project room (for admin sidebar)
                if (userType !== "support" && userType !== "admin") {
                    const projectRoom = `project_${projectId}`;

                    // --- Connection Counting Presence Update ---
                    if (!chatConnections.has(chatId)) chatConnections.set(chatId, new Set());
                    const sockets = chatConnections.get(chatId);
                    const wasAlreadyOnline = sockets.size > 0;
                    sockets.add(socket.id);

                    if (!wasAlreadyOnline) {
                        const statusPayload = {
                            chatId,
                            isOnline: true,
                            userId: userId
                        };
                        const statusToken = encryptMessage(JSON.stringify(statusPayload));

                        io.to(projectRoom).emit("chat_status", { token: statusToken });
                    }
                }

                // Generate JWE for session persistence
                const secureToken = await generateStudentJWE({
                    projectId,
                    chatId,
                    userId: userId || socket.id,
                    userType
                });

                // Encrypt entire response payload
                const responsePayload = {
                    roomKey,
                    message: "Successfully joined chat",
                    token: secureToken
                };

                const encryptedResponse = encryptMessage(JSON.stringify(responsePayload));

                // Send encrypted confirmation to the user
                socket.emit("joined_chat", {
                    token: encryptedResponse // Only send encrypted token
                });

            } catch (error) {
                console.error("Error joining chat:", error);
                socket.emit("error", { message: "Failed to join chat" });
            }
        });

        // ==================== JOIN PROJECT ROOM ====================
        socket.on("join_project", async (payload) => {
            let data = payload;
            if (payload && payload.token) {
                try {
                    const decrypted = decryptMessage(payload.token);
                    data = JSON.parse(decrypted);
                } catch (err) {
                    console.error("❌ Failed to decrypt join_project payload:", err);
                    return;
                }
            }

            const { projectId } = data;
            const userId = socket.user?.id ? String(socket.user.id) : "unknown";

            if (projectId) {
                const project = await Project.findOne({ projectId });
                if (!project) return;

                const projectRoom = `project_${projectId}`;
                socket.join(projectRoom);

                // Admins also join a dedicated admin-only project room
                if (socket.user?.role === 'admin') {
                    socket.join(`admin_project_${projectId}`);
                }

                // Send list of currently active chats (including all visitors)
                const MetadataModel = getMetadataModel(project.collections.metadata);
                const deletedChats = await MetadataModel.find({ projectId, isDeleted: true }).select("chatId").lean();
                const deletedChatIds = new Set(deletedChats.map(d => d.chatId));

                const activeChatIds = new Set();
                let visitorCount = 0;
                userRooms.forEach((info) => {
                    if (String(info.projectId) === String(projectId) && info.userType !== 'support' && info.userType !== 'admin') {
                        if (!deletedChatIds.has(info.chatId)) {
                            activeChatIds.add(info.chatId);
                            visitorCount++;
                        }
                    }
                });



                const activeChatPayload = {
                    chatIds: Array.from(activeChatIds)
                };

                const encryptedActiveChats = encryptMessage(JSON.stringify(activeChatPayload));

                socket.emit("active_chats", {
                    token: encryptedActiveChats
                });
            }
        });

        // ==================== LEAVE PROJECT ROOM ====================
        socket.on("leave_project", (payload) => {
            let data = payload;
            if (payload && payload.token) {
                try {
                    const decrypted = decryptMessage(payload.token);
                    data = JSON.parse(decrypted);
                } catch (err) { return; }
            }

            const { projectId } = data;
            if (projectId) {
                const projectRoom = `project_${projectId}`;
                socket.leave(projectRoom);
                if (socket.user?.role === 'admin') {
                    socket.leave(`admin_project_${projectId}`);
                }
            }
        });

        // ==================== SEND MESSAGE ====================
        socket.on("send_message", async (messagePayload) => {
            // ── Rate Limit Check ────────────────────────────────────────────────
            const _now = Date.now();
            const _timestamps = socketMessageTimestamps.get(socket.id) || [];
            const _recent = _timestamps.filter(t => _now - t < MESSAGE_RATE_WINDOW_MS);

            if (_recent.length >= MESSAGE_RATE_LIMIT) {
                socket.emit("rate_limited", {
                    message: "You are sending messages too fast. Please slow down.",
                    retryAfter: Math.ceil((MESSAGE_RATE_WINDOW_MS - (_now - _recent[0])) / 1000),
                });
                return; // Drop — no DB write, no broadcast
            }

            _recent.push(_now);
            socketMessageTimestamps.set(socket.id, _recent);
            // ────────────────────────────────────────────────────────────────────

            try {
                const {
                    projectId,
                    chatId,
                    senderType,
                    messageType = "text",
                    message,
                    fileUrl,
                    fileName,
                    replyTo,
                    isBold = false,
                } = messagePayload;

                // Get user info from stored room data to ensure correct senderId
                const roomInfo = userRooms.get(socket.id);


                // Inner Message Decryption:
                // Backward compatibility handling:
                // If the message field inside the encrypted payload is ALSO encrypted (double encryption),
                // we try to decrypt it.

                let plainMessage = message;
                if (message && messageType === 'text' && typeof message === 'string' && message.includes(':')) {
                    const maybeDecrypted = decryptMessage(message);
                    if (maybeDecrypted !== message) {
                        plainMessage = maybeDecrypted;
                    }
                }

                // Use the stored userId if available, otherwise fallback to the one in payload
                const senderId = roomInfo?.userId || messagePayload.senderId;
                // Use the stored userType if available to correctly identify admins/support
                const activeSenderType = roomInfo?.userType || senderType;



                // Validate required fields (using activeSenderType instead of payload senderType)
                if (!projectId || !chatId || !activeSenderType) {
                    console.error("Missing required fields:", { projectId, chatId, activeSenderType });
                    socket.emit("error", { message: "Missing required message fields" });
                    return;
                }

                // --- ROLE VERIFICATION ---
                // If the user attempts to send a message as a support agent or admin,
                // verify that their socket connection was actually authenticated.
                if ((activeSenderType === "support" || activeSenderType === "admin") && (!socket.user || !socket.user.verified || socket.user.role !== activeSenderType)) {
                    console.warn(`[SECURITY] Impersonation attempt blocked! Unverified user tried to send_message as ${activeSenderType} in project ${projectId}.`);
                    socket.emit("error", { message: "Unauthorized: Invalid sender role" });
                    return;
                }
                // -------------------------

                // Require message content only for text messages
                if (messageType === 'text' && !plainMessage) {
                    console.error("Missing message content");
                    socket.emit("error", { message: "Message content is required" });
                    return;
                }

                // ── Message length guard ───────────────────────────────────────────
                // Reject text messages that exceed the maximum allowed length to prevent
                // resource exhaustion attacks (very large messages filling the database).
                if (messageType === 'text' && plainMessage && plainMessage.length > MAX_MESSAGE_LENGTH) {
                    socket.emit("error", {
                        message: `Message is too long. Maximum ${MAX_MESSAGE_LENGTH.toLocaleString()} characters allowed.`
                    });
                    return;
                }
                // ─────────────────────────────────────────────────────────────────

                // Get the project to find the correct collection name
                const project = await Project.findOne({ projectId });
                if (!project) {
                    console.error(" Project not found:", projectId);
                    socket.emit("error", { message: "Project not found" });
                    return;
                }


                // Get the dynamic message model
                const MessageModel = getMessageModel(project.collections.messages);

                let finalSenderId = senderId;

                // Ownership check for support users
                // Ownership check removed: "Active Assignee" logic allows any support user to message
                // and automatically take active control.

                // If student, try to get their email/name from metadata for better identification, and CREATE metadata if first message
                if (activeSenderType === "student") {
                    try {
                        const MetadataModel = getMetadataModel(project.collections.metadata);
                        let metadata = await MetadataModel.findOne({ chatId });
                        // ── RATING ENFORCEMENT REMOVED (v9) ──────────────────────────
                        // Students are no longer blocked from sending messages even if a rating is pending.
                        /*
                        if ((metadata?.pendingRatingCount || 0) > 0) {
                            socket.emit("error", {
                                code: "RATING_REQUIRED",
                                message: "Please provide a rating for this chat before sending a new message."
                            });
                            return;
                        }
                        */
                        // ───────────────────────────────────────────────────────────────

                        if (!metadata) {
                            // First message sent by student -> create metadata so the chat appears in Admin/Support Dashboard
                            const storedSessionInfo = roomInfo?.initialSessionInfo || {};
                            metadata = await MetadataModel.create({
                                projectId,
                                chatId,
                                userId: senderId,
                                status: "pending",
                                ...storedSessionInfo,
                                history: roomInfo?.initialSessionInfo ? [storedSessionInfo] : [],
                                helpCycles: [{ startedAt: new Date() }] // Start the first help cycle
                            });

                            // Create the system welcome message so support users see it and history captures it!
                            const MessageModelRef = getMessageModel(project.collections.messages);
                            const welcomeBotMessage = new MessageModelRef({
                                projectId,
                                chatId,
                                senderType: "support", // Emulate a support bot
                                senderId: "system",
                                messageType: "text",
                                message: project?.widgetConfig?.welcomeMessage || "Hello! How can we help you today?",
                                status: "sent"
                            });

                            // Force createdAt to be exactly 1 ms before the user's actual first message to enforce chronological order
                            const studentMessageDate = new Date();
                            welcomeBotMessage.createdAt = new Date(studentMessageDate.getTime() - 1000);
                            await welcomeBotMessage.save();

                            // CLEAN THE OBJECT before encrypting! The widget cannot parse raw Mongoose instances!
                            const welcomeMsgObj = {
                                _id: welcomeBotMessage._id,
                                projectId: welcomeBotMessage.projectId,
                                chatId: welcomeBotMessage.chatId,
                                senderType: welcomeBotMessage.senderType,
                                senderId: welcomeBotMessage.senderId,
                                messageType: welcomeBotMessage.messageType,
                                message: welcomeBotMessage.message,
                                status: welcomeBotMessage.status,
                                createdAt: welcomeBotMessage.createdAt,
                                updatedAt: welcomeBotMessage.updatedAt
                            };

                            // Broadcast it properly to everyone in the room AND the global Project room so the Support Dashboard instantly updates
                            const secureWelcomeToken = encryptMessage(JSON.stringify(welcomeMsgObj));
                            io.to(`${projectId}_${chatId}`).emit("new_message", { token: secureWelcomeToken }); // Send to specific chat room
                            io.to(`project_${projectId}`).emit("new_message", { token: secureWelcomeToken }); // Send to Support Staff dashboard list
                        } else if (!metadata.helpCycles || metadata.helpCycles.length === 0) {
                            // Chat was pre-created in join_chat (e.g. they provided email), but this is their first real message!
                            const cycleStart = new Date();
                            await MetadataModel.updateOne(
                                { chatId },
                                { $set: { helpCycles: [{ startedAt: cycleStart }] } }
                            );
                            metadata.helpCycles = [{ startedAt: cycleStart }];
                        }

                        if (metadata && (metadata.email || metadata.name)) {
                            finalSenderId = metadata.email || metadata.name;
                        }
                    } catch (err) {
                        console.error("Error fetching or creating metadata for senderId:", err);
                    }
                }

                // Create new message
                const messageData = {
                    projectId,
                    chatId,
                    senderType: activeSenderType,
                    senderId: finalSenderId || null,
                    messageType,
                    message: plainMessage, // Store plaintext/decrypted text
                    fileUrl: fileUrl || null,
                    fileName: fileName || null,
                    replyTo: replyTo || null,
                    isBold: !!isBold,
                    status: "sent",
                };


                const newMessage = new MessageModel(messageData);
                await newMessage.save();

                // ── EXACT REAL-TIME AUTO-RESOLVE TIMER ─────────────────────────────
                // Agent speaks → start/reset a 120-second exact countdown.
                // Student speaks → cancel any active timer (don't auto-resolve).
                if (activeSenderType === 'support' || activeSenderType === 'admin') {
                    if (resolveTimeouts.has(chatId)) clearTimeout(resolveTimeouts.get(chatId));
                    const _io = socket.server;
                    const _projectId = projectId;
                    const _chatId = chatId;
                    const tId = setTimeout(async () => {
                        await resolveChat(_io, _projectId, _chatId, 'Auto-Resolve');
                        resolveTimeouts.delete(_chatId);
                    }, 2 * 60 * 1000);
                    resolveTimeouts.set(chatId, tId);
                } else if (activeSenderType === 'student') {
                    if (resolveTimeouts.has(chatId)) {
                        clearTimeout(resolveTimeouts.get(chatId));
                        resolveTimeouts.delete(chatId);
                    }
                }
                // ───────────────────────────────────────────────────────────────────

                // Populate replyTo before emitting
                if (newMessage.replyTo) {
                    await newMessage.populate({
                        path: 'replyTo',
                        model: MessageModel,
                        select: 'message senderType senderId messageType fileUrl fileName isDeleted status createdAt'
                    });
                }

                // ── Auto-Resolve Tracking (DB lastMessageDetails sync) ────────────
                try {
                    // We only update lastMessageDetails when an agent (support/admin) messages.
                    // If a student messages, we explicitly CLEAR it so auto-resolve timer stops.
                    if (activeSenderType === 'support' || activeSenderType === 'admin') {
                        const MetadataModel = getMetadataModel(project.collections.metadata);
                        const metaForTracking = await MetadataModel.findOne({ chatId }).lean();
                        const activeAssignee = metaForTracking?.assignedTo || metaForTracking?.originalAssignedTo || null;

                        await MetadataModel.updateOne(
                            { chatId },
                            {
                                $set: {
                                    lastMessageDetails: {
                                        timestamp: newMessage.createdAt,
                                        senderType: activeSenderType,
                                        chatId: chatId,
                                        activeAssigneeAtTimeOfMessage: activeAssignee ? String(activeAssignee) : null
                                    }
                                }
                            }
                        );
                    } else if (activeSenderType === 'student') {
                        const MetadataModel = getMetadataModel(project.collections.metadata);
                        const meta = await MetadataModel.findOne({ chatId }).lean();

                        const updateOps = { $set: { lastMessageDetails: null } };
                        if (meta && meta.status === 'resolved') {
                            // Student reopens chat
                            updateOps.$set.status = 'unresolved';
                            updateOps.$set.assistants = [];
                            updateOps.$set.ratingRequested = false;
                            updateOps.$set.reviewRequested = false;
                            updateOps.$set.pendingRatingCount = 0;
                            updateOps.$push = {
                                assistantHistory: meta.assistants || [],
                                transferHistory: [], // start new session
                                helpCycles: { startedAt: newMessage.createdAt }
                            };
                        }

                        await MetadataModel.updateOne({ chatId }, updateOps);

                        // Broadcast unresolve event to dashboard and widget
                        if (meta && meta.status === 'resolved') {
                            const statusPayload = {
                                chatId,
                                projectId,
                                status: 'unresolved',
                                autoUnresolved: true,
                                pendingRatingCount: 0,
                                ratingRequested: false,
                                lastMessage: {
                                    message: plainMessage,
                                    senderType: 'student',
                                    createdAt: newMessage.createdAt
                                }
                            };
                            const statusToken = encryptMessage(JSON.stringify(statusPayload));

                            // Emit to all relevant rooms
                            const io = socket.server;
                            if (io) {
                                io.to(`project_${projectId}`).emit('chat_status_changed', { token: statusToken });
                                io.to(`${projectId}_${chatId}`).emit('chat_status_changed', { token: statusToken });
                                io.to(`${projectId}_${chatId}`).emit('chat_status_updated', { token: statusToken });
                            }
                        }
                    }
                } catch (metaErr) {
                    console.error("Error updating lastMessageDetails for auto-resolve:", metaErr);
                }
                // ────────────────────────────────────────────────────────


                const roomKey = `${projectId}_${chatId}`;

                // Sign URL for real-time emission
                let signedFileUrl = newMessage.fileUrl;
                if (signedFileUrl) {
                    signedFileUrl = await signUrl(signedFileUrl);
                }

                // Prepare message object for transmission
                const messageObject = {
                    _id: newMessage._id,
                    projectId: newMessage.projectId,
                    chatId: newMessage.chatId,
                    senderType: newMessage.senderType,
                    senderId: newMessage.senderId,
                    messageType: newMessage.messageType,
                    message: newMessage.message, // Plain text (from DB)
                    fileUrl: signedFileUrl,
                    fileName: newMessage.fileName,
                    replyTo: newMessage.replyTo,
                    isBold: newMessage.isBold,
                    reactions: newMessage.reactions || [],
                    status: newMessage.status,
                    createdAt: newMessage.createdAt,
                    updatedAt: newMessage.updatedAt,
                    isDeleted: false,
                    logo: project?.widgetConfig?.logoUrl || '',
                    primaryColor: project?.widgetConfig?.primaryColor || '#4f46e5'
                };

                // ── TARGETED PROJECT-ROOM EMIT ──────────────────────────────────────────
                // For student messages, only notify the ASSIGNED agent.
                // Support/admin messages are already delivered inside the chat room above.
                let chatMeta = null;
                const MetadataModel = getMetadataModel(project.collections.metadata);
                if (activeSenderType === "student") {
                    chatMeta = await MetadataModel.findOne({ chatId }).lean();
                    if (chatMeta && (chatMeta.name || chatMeta.email)) {
                        messageObject.senderName = chatMeta.name || chatMeta.email;
                    }
                }
                

                // Encrypt the ENTIRE message object for the "Full Response in Token" requirement
                const fullPayloadToken = encryptMessage(JSON.stringify(messageObject));

                // Emit to all users in the room (the specific chat room — student + support in that chat)
                io.to(roomKey).emit("new_message", { token: fullPayloadToken });

                if (activeSenderType === "student") {
                    // Look up assignment status

                    // Use the same "effective owner" logic:
                    const assignedToId = chatMeta?.assignedTo
                        ? String(chatMeta.assignedTo)
                        : (chatMeta?.originalAssignedTo && !['system', 'bot'].includes(String(chatMeta.originalAssignedTo))
                            ? String(chatMeta.originalAssignedTo)
                            : null);

                    // Reset per-user notification seen-by list so the badge re-appears
                    await MetadataModel.updateOne(
                        { chatId },
                        { $set: { notificationsSeenBy: [], lastStudentMessageAt: new Date() } }
                    );

                    // ── AUTO-UNRESOLVE ──────────────────────────────────────────────────────
                    // If the chat was resolved and the student sends a new message,
                    // flip it back to unresolved and push a fresh empty inner-array onto
                    // transferHistory so this new session stays clean.
                    // Also start a new Help Cycle for accurate pickup speed.
                    if (chatMeta?.status === 'resolved') {
                        await MetadataModel.updateOne(
                            { chatId },
                            {
                                $set: {
                                    status: 'unresolved',
                                    assistants: [],
                                    ratingRequested: false,   // REFRESH on re-open
                                    pendingRatingCount: 0     // CLEAN on re-open
                                },
                                $push: {
                                    assistantHistory: chatMeta.assistants ?? [],
                                    transferHistory: [],              // new transfer session
                                    helpCycles: { startedAt: newMessage.createdAt }
                                },
                            }
                        );

                        const statusChangePayload = {
                            chatId,
                            projectId,
                            status: 'unresolved',
                            autoUnresolved: true,
                            // Ensure UI clears ownership on re-open (it becomes unassigned)
                            assignedTo: null,
                            originalAssignedTo: null,
                            assistants: []
                        };
                        const statusChangeToken = encryptMessage(JSON.stringify(statusChangePayload));
                        io.to(`project_${projectId}`).emit('chat_status_changed', { token: statusChangeToken });
                    }
                    // ───────────────────────────────────────────────────────────────────────

                    // ── PER-USER personalised unread_count_update ───────────────────────
                    // Every support/admin user in the project gets their OWN total unread
                    // and their own per-chat unread count updated in real-time.
                    // This handles assigned/unassigned cases uniformly for all staff.
                    const projectRoomSockets = await io.in(`project_${projectId}`).fetchSockets();
                    const seenUserIds = new Set();
                    for (const s of projectRoomSockets) {
                        const uid = s.user?.id ? String(s.user.id) : null;
                        if (!uid || seenUserIds.has(uid)) continue;
                        seenUserIds.add(uid);
                        const role = s.user?.role || 'support';

                        // Personalized counts for this specific user
                        const [personalizedTotal, personalizedChatCount] = await Promise.all([
                            getPersonalizedUnreadCount(project, uid, role),
                            getChatUnreadCount(project, chatId, uid, role)
                        ]);

                        const unreadUpdatePayload = {
                            projectId,
                            chatId,
                            type: 'new_message',
                            totalUnreadCount: personalizedTotal,
                            unreadCount: personalizedChatCount
                        };
                        const unreadUpdateToken = encryptMessage(JSON.stringify(unreadUpdatePayload));
                        io.to(`user_${uid}`).emit("unread_count_update", { token: unreadUpdateToken });
                        // Invalidate dashboard stats for this support user
                        emitStatsInvalidated(io, uid);
                    }

                    // Broadcast new_message to the project room (sidebar preview and re-sorting for everyone).
                    io.to(`project_${projectId}`).emit("new_message", { token: fullPayloadToken });

                    // Handle unassigned chats: notify all product staff
                    if (!assignedToId) {

                        // Notify ALL product-assigned support users with personalised unread counts.
                        // This covers the re-open-after-resolve case where the chat is ownerless.
                        try {
                            const ProjectSupportUser = (await import('../model/ProjectSupportUser.js')).default;
                            const assignments = await ProjectSupportUser.find({
                                projectId: project._id,
                                isActive: true
                            }).lean();

                            for (const assignment of assignments) {
                                const uid = String(assignment.supportUserId);
                                if (seenUserIds.has(uid)) continue; // Already notified via online socket loop
                                seenUserIds.add(uid);

                                const [personalizedTotal, personalizedChatCount] = await Promise.all([
                                    getPersonalizedUnreadCount(project, uid, 'support'),
                                    getChatUnreadCount(project, chatId, uid, 'support')
                                ]);
                                const unreadUpdatePayload = {
                                    projectId,
                                    chatId,
                                    type: 'new_message',
                                    totalUnreadCount: personalizedTotal,
                                    unreadCount: personalizedChatCount
                                };
                                const unreadUpdateToken = encryptMessage(JSON.stringify(unreadUpdatePayload));
                                io.to(`user_${uid}`).emit("new_message", { token: fullPayloadToken });
                                io.to(`user_${uid}`).emit("unread_count_update", { token: unreadUpdateToken });
                            }
                        } catch (notifyErr) {
                            console.error("Error notifying product agents for unassigned chat:", notifyErr);
                            // No fallback needed as online users already received updates via the first loop
                        }
                    } else if (!seenUserIds.has(assignedToId)) {
                        // If the chat IS assigned but the owner isn't in the project room sockets, 
                        // ensure they get a direct notification if they are connected elsewhere.
                        try {
                            const [personalizedTotal, personalizedChatCount] = await Promise.all([
                                getPersonalizedUnreadCount(project, assignedToId, 'support'),
                                getChatUnreadCount(project, chatId, assignedToId, 'support')
                            ]);
                            const unreadUpdatePayload = {
                                projectId,
                                chatId,
                                type: 'new_message',
                                totalUnreadCount: personalizedTotal,
                                unreadCount: personalizedChatCount
                            };
                            const unreadUpdateToken = encryptMessage(JSON.stringify(unreadUpdatePayload));
                            io.to(`user_${assignedToId}`).emit("unread_count_update", { token: unreadUpdateToken });
                        } catch (assignedErr) {
                            console.error("Error notifying assigned agent:", assignedErr);
                        }
                    }

                    // ── PERSISTENT NOTIFICATION FOR STUDENT MESSAGE ──
                    try {
                        const notificationData = {
                            type: 'new_message',
                            title: chatMeta?.name || chatMeta?.email || 'Student',
                            body: plainMessage || 'Sent a file',
                            chatId,
                            projectId,
                        };

                        if (assignedToId) {
                            // Notify only the assigned agent
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

                            // Also send to the new Web Push service
                            sendWebNotification(assignedToId, {
                                title: newNotification.title,
                                body: newNotification.body,
                                type: newNotification.type,
                                chatId: newNotification.chatId,
                                projectId: newNotification.projectId
                            }).catch(console.error);
                        } else {
                            // Notify ALL active support users assigned to this project
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

                                    // Also send to the new Web Push service
                                    sendWebNotification(notif.userId, {
                                        title: notif.title,
                                        body: notif.body,
                                        type: notif.type,
                                        chatId: notif.chatId,
                                        projectId: notif.projectId
                                    }).catch(console.error);
                                }
                            }
                        }
                    } catch (notifyErr) {
                        console.error("Error saving student message notifications:", notifyErr);
                    }
                }
                else {
                    // Support / admin message — still let everyone in the project room know
                    // (sidebar previews etc.)
                    io.to(`project_${projectId}`).emit("new_message", { token: fullPayloadToken });
                }
                // ────────────────────────────────────────────────────────────────────────

                // If support/admin is replying, only track the very first replier as originalAssignedTo.
                // Also set assignedTo so they appear in Chat Ownership immediately.
                if (activeSenderType === 'support' || activeSenderType === 'admin') {
                    try {
                        const agentId = senderId ? String(senderId) : null;
                        if (agentId) {
                            const MetadataModel = getMetadataModel(project.collections.metadata);
                            const existingMeta = await MetadataModel.findOne({ chatId });

                            if (!existingMeta) {
                                // First ever reply — record original assignee AND make them active assignee
                                // Also look up agent name for originalAssigneeHistory
                                let agentName = null;
                                try {
                                    let agentDoc = await SupportUser.findById(agentId).select('username email').lean();
                                    if (!agentDoc) agentDoc = await Admin.findById(agentId).select('username email').lean();
                                    if (agentDoc) agentName = agentDoc.username || agentDoc.email || null;
                                } catch (_) { }

                                await MetadataModel.create({
                                    projectId,
                                    chatId,
                                    originalAssignedTo: agentId,
                                    assignedTo: agentId,
                                    assistants: [agentId],
                                    status: "unresolved",
                                    helpCycles: [{ startedAt: new Date(), pickedUpAt: new Date(), pickedUpBy: agentId }]
                                });

                                // 🔥 FIX: Broadcast to all OTHER users that this chat is now claimed.
                                // Without this, B's badge stays until page refresh even though
                                // A has formally claimed the chat via their first reply.
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
                                        console.error("Failed to clear stale unread count for", uid, err);
                                    }
                                }
                            } else {
                                // Update existing metadata: record assignee if missing, and move to unresolved if pending
                                // Update existing metadata: record assignee if missing, and move to unresolved if pending
                                const updateObj = {};
                                let pushOps = null;

                                // 🔥 ACTIVE ASSIGNEE LOGIC 🔥
                                // Every support/admin message automatically makes them the active owner
                                updateObj.assignedTo = agentId;
                                if (!existingMeta.originalAssignedTo || ['system', 'bot'].includes(existingMeta.originalAssignedTo)) {
                                    updateObj.originalAssignedTo = agentId;
                                }
                                if (existingMeta.status === 'pending') {
                                    updateObj.status = 'unresolved';
                                }
                                pushOps = { $addToSet: { assistants: agentId } };

                                // Pickup Speed Logic: Find the latest helpCycle without a pickup
                                let cycleUpdateOps = null;
                                if (existingMeta.helpCycles && existingMeta.helpCycles.length > 0) {
                                    const lastCycleIdx = existingMeta.helpCycles.length - 1;
                                    const lastCycle = existingMeta.helpCycles[lastCycleIdx];
                                    if (!lastCycle.pickedUpAt) {
                                        cycleUpdateOps = {
                                            $set: {
                                                [`helpCycles.${lastCycleIdx}.pickedUpAt`]: new Date(),
                                                [`helpCycles.${lastCycleIdx}.pickedUpBy`]: agentId
                                            }
                                        };
                                    }
                                }

                                if (Object.keys(updateObj).length > 0 || cycleUpdateOps || pushOps) {
                                    const mongoUpdate = {};
                                    if (Object.keys(updateObj).length > 0 || cycleUpdateOps) {
                                        mongoUpdate.$set = { ...updateObj };
                                        if (cycleUpdateOps) {
                                            mongoUpdate.$set = { ...mongoUpdate.$set, ...cycleUpdateOps.$set };
                                        }
                                    }
                                    if (pushOps) {
                                        mongoUpdate.$addToSet = pushOps.$addToSet;
                                    }
                                    await MetadataModel.updateOne({ chatId }, mongoUpdate);

                                    // Notify frontend about the ownership change instantly
                                    const updateToken = encryptMessage(JSON.stringify({
                                        chatId,
                                        projectId,
                                        assignedTo: agentId,
                                        isSilent: true
                                    }));
                                    io.to(`${projectId}_${chatId}`).emit('assignment_updated', { token: updateToken });
                                }

                                // 🔥 CRITICAL FIX: The chat is now formally assigned to `agentId`.
                                // Let's tell everyone else in the project room that their unread counts dropped,
                                // because they are no longer responsible for this previously unassigned chat!
                                if (updateObj.assignedTo === agentId) {
                                    const projectRoomSockets = await io.in(`project_${projectId}`).fetchSockets();
                                    const seenUsers = new Set();
                                    for (const s of projectRoomSockets) {
                                        const uid = s.user?.id ? String(s.user.id) : null;
                                        // Skip the guy who just claimed it (they handle their own counts via assigned block)
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
                                                type: 'chat_assigned', // Clear badge flag
                                                totalUnreadCount: personalizedTotal,
                                                unreadCount: personalizedChatCount
                                            };
                                            const clearToken = encryptMessage(JSON.stringify(unreadUpdatePayload));
                                            io.to(`user_${uid}`).emit("unread_count_update", { token: clearToken });
                                        } catch (err) {
                                            console.error("Failed to clear stale unread count for", uid, err);
                                        }
                                    }
                                }
                            }
                        }
                    } catch (assignErr) {
                        console.error('Auto-assign/status-update error:', assignErr);
                    }
                }



            } catch (error) {
                console.error("Error sending message:", error);
                socket.emit("error", { message: "Failed to send message" });
            }
        });

        // ==================== TYPING INDICATOR ====================
        socket.on("typing", (typingData) => {
            let data = typingData;
            if (data && data.token) {
                try {
                    const decrypted = decryptMessage(data.token);
                    data = JSON.parse(decrypted);
                } catch (err) {
                    console.error("Failed to decrypt typing data:", err);
                    return;
                }
            }

            const { projectId, chatId, userId, userType, isTyping } = data;

            if (!projectId || !chatId) return;

            // --- ROLE VERIFICATION ---
            if ((userType === "support" || userType === "admin") && (!socket.user || !socket.user.verified || socket.user.role !== userType)) {
                console.warn(`[SECURITY] Impersonation attempt blocked! Unverified user tried to broadcast typing as ${userType}.`);
                return; // Silently drop
            }
            // -------------------------

            const roomKey = `${projectId}_${chatId}`;

            // Encrypt the typing indicator data before broadcasting
            const typingPayload = {
                chatId,
                userId,
                userType,
                isTyping,
            };
            const token = encryptMessage(JSON.stringify(typingPayload));

            socket.to(roomKey).emit("user_typing", { token });
            socket.to(`project_${projectId}`).emit("project_user_typing", { token });
        });

        // ==================== MESSAGE DELIVERED ====================
        socket.on("message_delivered", async (rawPayload) => {
            // Decrypt token if present (support frontend and widget both send { token })
            let payload = rawPayload;
            if (rawPayload?.token) {
                try {
                    payload = JSON.parse(decryptMessage(rawPayload.token));
                } catch (err) {
                    console.error("❌ Failed to decrypt message_delivered:", err);
                    return;
                }
            }
            const { messageId, projectId } = payload;

            // Skip database operations for virtual messages (client-side only)
            if (messageId && String(messageId).startsWith('virtual_resolved_')) return;

            try {
                const project = await Project.findOne({ projectId });
                if (!project) return;

                const MessageModel = getMessageModel(project.collections.messages);

                // Only update and emit if current status is 'sent'
                // This prevents redundant DB writes and socket broadcasts when 
                // multiple support users have the chat open.
                const updatedMessage = await MessageModel.findOneAndUpdate(
                    { _id: messageId, status: "sent" },
                    { $set: { status: "delivered" } },
                    { new: true }
                );

                if (updatedMessage) {
                    const roomKey = `${projectId}_${updatedMessage.chatId}`;
                    const statusPayload = {
                        messageId,
                        status: "delivered",
                    };
                    const token = encryptMessage(JSON.stringify(statusPayload));
                    io.to(roomKey).emit("message_status_updated", { token });
                }
            } catch (error) {
                console.error("Error updating message status:", error);
            }
        });

        // ==================== MESSAGE READ ====================
        socket.on("message_read", async (rawPayload) => {
            // Decrypt token if present (support frontend and widget both send { token })
            let payload = rawPayload;
            if (rawPayload?.token) {
                try {
                    payload = JSON.parse(decryptMessage(rawPayload.token));
                } catch (err) {
                    console.error("❌ Failed to decrypt message_read:", err);
                    return;
                }
            }
            const { messageId, projectId } = payload;

            // Skip database operations for virtual messages (client-side only)
            if (messageId && String(messageId).startsWith('virtual_resolved_')) return;

            try {
                const project = await Project.findOne({ projectId });
                if (!project) return;

                const MessageModel = getMessageModel(project.collections.messages);
                const MetadataModel = getMetadataModel(project.collections.metadata);
                const readerId = socket.user?.id ? String(socket.user.id) : null;

                // Load the message first to get chatId
                const message = await MessageModel.findById(messageId);
                if (!message) return;

                const chatId = message.chatId;

                // ── ASSIGNMENT CHECK ──────────────────────────────────────────────────
                // Only mark globally 'seen' in the DB if the chat is formally assigned
                // to this reader. For unassigned chats we MUST NOT touch the global
                // status field — doing so zeros B's badge count because the
                // unread-count query uses `status: { $ne: 'seen' }` as a shared filter.
                const meta = await MetadataModel.findOne({ chatId }).lean();
                const assignedId = meta?.assignedTo ? String(meta.assignedTo) : null;
                const origId = (meta?.originalAssignedTo &&
                    !['system', 'bot'].includes(String(meta.originalAssignedTo)))
                    ? String(meta.originalAssignedTo) : null;
                const owner = assignedId ?? origId;
                const isAdmin = socket.user?.role === 'admin';
                const isStudent = socket.user?.role === 'student';
                const chatIsAssignedToReader = !!owner && owner === readerId;

                let updatedMessage = null;
                if (chatIsAssignedToReader || isAdmin || isStudent) {
                    // Global seen criteria:
                    // 1. Assigned agent reading student messages
                    // 2. Admin reading student messages
                    // 3. Student reading staff messages
                    const senderTypeFilter = isStudent ? { $in: ['support', 'admin'] } : 'student';

                    updatedMessage = await MessageModel.findOneAndUpdate(
                        { _id: messageId, senderType: senderTypeFilter, status: { $ne: "seen" } },
                        { $set: { status: "seen", readAt: new Date() } },
                        { new: true }
                    );
                } else {
                    // UNASSIGNED chat: only update per-user last-seen timestamp.
                    // This preserves the global 'delivered' status so other support
                    // users' badge counts remain accurate on page refresh.
                    if (readerId) {
                        const now = new Date();
                        await MetadataModel.updateOne({ chatId }, {
                            $addToSet: { notificationsSeenBy: readerId },
                            $set: { [`userLastSeenAt.${readerId}`]: now }
                        });
                    }
                }

                // We still need the message object for broadcasts
                const finalMessage = updatedMessage || message;

                if (finalMessage) {
                    const roomKey = `${projectId}_${finalMessage.chatId}`;

                    // Only broadcast status change to the room if WE were the ones who flipped it to 'seen'
                    if (updatedMessage) {
                        const statusPayload = {
                            messageId,
                            status: "seen",
                            readAt: finalMessage.readAt,
                        };
                        const token = encryptMessage(JSON.stringify(statusPayload));
                        io.to(roomKey).emit("message_status_updated", { token });
                    }
                    // When a message is marked 'seen' globally (by assignee reading it),
                    // we must notify ALL interested parties (Admins, assignee) to update their total unread counts.
                    const projectRoomSockets = await io.in(`project_${projectId}`).fetchSockets();
                    const seenUserIds = new Set();
                    for (const s of projectRoomSockets) {
                        const uid = s.user?.id ? String(s.user.id) : null;
                        if (!uid || seenUserIds.has(uid)) continue;
                        seenUserIds.add(uid);
                        const role = s.user?.role || 'support';

                        try {
                            const [personalizedTotal, personalizedChatCount] = await Promise.all([
                                getPersonalizedUnreadCount(project, uid, role),
                                getChatUnreadCount(project, chatId, uid, role)
                            ]);

                            const unreadUpdatePayload = {
                                projectId,
                                chatId: finalMessage.chatId,
                                type: 'read',
                                totalUnreadCount: personalizedTotal,
                                unreadCount: personalizedChatCount
                            };
                            const unreadUpdateToken = encryptMessage(JSON.stringify(unreadUpdatePayload));
                            io.to(`user_${uid}`).emit("unread_count_update", { token: unreadUpdateToken });
                        } catch (err) {
                            console.error(`Failed to sync unread count for user ${uid} after read:`, err);
                        }
                    }
                }
            } catch (error) {
                console.error("Error updating message read status:", error);
            }
        });


        // ==================== DELETE MESSAGE ====================
        socket.on("delete_message", async (payload) => {
            const { messageId, projectId, chatId } = payload;

            // Skip database operations for virtual messages (client-side only)
            if (messageId && String(messageId).startsWith('virtual_resolved_')) {
                socket.emit("error", { message: "System messages cannot be deleted." });
                return;
            }

            try {
                // ── GUARD 1: Block unverified (student/widget) users ──────────────
                // socket.user.verified is set to false for unauthenticated widget users.
                // Students are never allowed to delete messages via the socket.
                if (!socket.user || !socket.user.verified) {
                    socket.emit("error", { message: "You do not have permission to delete messages." });
                    return;
                }

                const project = await Project.findOne({ projectId });
                if (!project) {
                    socket.emit("error", { message: "Project not found" });
                    return;
                }

                const MessageModel = getMessageModel(project.collections.messages);

                // ── GUARD 2: Load the message first — reject if not found ─────────
                const existingMessage = await MessageModel.findById(messageId);
                if (!existingMessage) {
                    socket.emit("error", { message: "Message not found." });
                    return;
                }

                // ── GUARD 3: Ownership check ──────────────────────────────────────
                // Admins may delete any message.
                // Support users may only delete messages where they are the sender.
                const callerId = String(socket.user.id);
                const isAdmin = socket.user.role === "admin";
                const isOwner = String(existingMessage.senderId) === callerId;

                if (!isAdmin && !isOwner) {
                    socket.emit("error", { message: "You do not have permission to delete this message." });
                    return;
                }
                // ─────────────────────────────────────────────────────────────────

                await MessageModel.findByIdAndUpdate(messageId, {
                    isDeleted: true,
                });

                const roomKey = `${projectId}_${chatId}`;
                const deletePayload = {
                    messageId,
                    deleteType: 'all',
                    userId: callerId
                };
                const token = encryptMessage(JSON.stringify(deletePayload));

                io.to(roomKey).emit("message_deleted", { token });

                // ── SYNC UNREAD COUNTS AFTER DELETION ──────────────────────────
                // If a student's unread message was deleted, we must notify all staff
                // members to update their badges.
                if (existingMessage.senderType === 'student' && existingMessage.status !== 'seen') {
                    const projectRoomSockets = await io.in(`project_${projectId}`).fetchSockets();
                    const seenUserIds = new Set();
                    for (const s of projectRoomSockets) {
                        const uid = s.user?.id ? String(s.user.id) : null;
                        if (!uid || seenUserIds.has(uid)) continue;
                        seenUserIds.add(uid);
                        const role = s.user?.role || 'support';

                        try {
                            const [personalizedTotal, personalizedChatCount] = await Promise.all([
                                getPersonalizedUnreadCount(project, uid, role),
                                getChatUnreadCount(project, chatId, uid, role)
                            ]);

                            const unreadUpdatePayload = {
                                projectId,
                                chatId,
                                type: 'delete_message',
                                totalUnreadCount: personalizedTotal,
                                unreadCount: personalizedChatCount
                            };
                            const unreadUpdateToken = encryptMessage(JSON.stringify(unreadUpdatePayload));
                            io.to(`user_${uid}`).emit("unread_count_update", { token: unreadUpdateToken });
                        } catch (err) {
                            console.error(`Failed to sync unread count for user ${uid} after deletion:`, err);
                        }
                    }
                }
                // ──────────────────────────────────────────────────────────────


            } catch (error) {
                console.error("Error deleting message:", error);
                socket.emit("error", { message: "Failed to delete message" });
            }
        });

        // ==================== PIN MESSAGE ====================
        socket.on("pin_message", async (payload) => {
            const { messageId, projectId, chatId, isPinned, duration } = payload;

            // Skip database operations for virtual messages (client-side only)
            if (messageId && String(messageId).startsWith('virtual_resolved_')) {
                socket.emit("error", { message: "System messages cannot be pinned." });
                return;
            }

            try {
                // ── GUARD: Block unverified (student/widget) users ────────────────
                // Only admins and support users (verified sockets) may pin messages.
                // Widget users connect without a JWT and have verified = false.
                if (!socket.user || !socket.user.verified) {
                    socket.emit("error", { message: "You do not have permission to pin messages." });
                    return;
                }
                // ─────────────────────────────────────────────────────────────────

                const project = await Project.findOne({ projectId });
                if (!project) {
                    socket.emit("error", { message: "Project not found" });
                    return;
                }

                const MessageModel = getMessageModel(project.collections.messages);

                const updateData = {
                    isPinned: isPinned === true,
                };

                if (isPinned === true) {
                    // Check if message is already pinned to avoid double counting
                    const currentMsg = await MessageModel.findById(messageId);
                    if (currentMsg && !currentMsg.isPinned) {
                        const pinnedCount = await MessageModel.countDocuments({ chatId, isPinned: true });
                        if (pinnedCount >= 3) {
                            socket.emit("error", { message: "Maximum 3 pinned messages allowed" });
                            return;
                        }
                    }

                    updateData.pinnedAt = new Date();
                    if (duration) {
                        const expiresAt = new Date();
                        expiresAt.setHours(expiresAt.getHours() + duration);
                        updateData.pinExpiresAt = expiresAt;
                    } else {
                        updateData.pinExpiresAt = null;
                    }
                } else {
                    updateData.pinnedAt = null;
                    updateData.pinExpiresAt = null;
                }

                const message = await MessageModel.findByIdAndUpdate(messageId, updateData, { new: true });

                if (!message) {
                    socket.emit("error", { message: "Message not found" });
                    return;
                }

                const roomKey = `${projectId}_${chatId}`;
                const pinPayload = {
                    messageId,
                    isPinned: isPinned === true,
                    message: message.message,
                    senderType: message.senderType,
                    messageType: message.messageType,
                    pinExpiresAt: message.pinExpiresAt,
                };
                const token = encryptMessage(JSON.stringify(pinPayload));

                // Broadcast once to all users in the chat room
                io.to(roomKey).emit("message_pinned", { token });

            } catch (error) {
                console.error("Error pinning message:", error);
                socket.emit("error", { message: "Failed to pin message" });
            }
        });

        // ==================== ASSIGN CHAT (Transfer to another support user) ====================
        socket.on("assign_chat", async (payload) => {
            const { projectId, chatId, targetSupportUserIds } = payload;
            try {
                if (!projectId || !chatId || !targetSupportUserIds || !Array.isArray(targetSupportUserIds) || targetSupportUserIds.length === 0) {
                    socket.emit("error", { message: "Missing required fields for assign_chat" });
                    return;
                }

                const callerId = socket.user?.id ? String(socket.user.id) : null;
                if (!callerId) { socket.emit("error", { message: "Unauthorized" }); return; }

                const project = await Project.findOne({ projectId });
                if (!project) { socket.emit("error", { message: "Project not found" }); return; }

                const MetadataModel = getMetadataModel(project.collections.metadata);
                const meta = await MetadataModel.findOne({ chatId });

                // The effective chat owner is: current assignedTo if set, otherwise the originalAssignedTo
                const assignedId = meta?.assignedTo ? String(meta.assignedTo) : null;
                const origId = (meta?.originalAssignedTo && !['system', 'bot'].includes(String(meta.originalAssignedTo)))
                    ? String(meta.originalAssignedTo) : null;
                const effectiveOwner = assignedId ?? origId;

                const isAdmin = socket.user?.role?.toLowerCase() === 'admin';

                if (!meta || (effectiveOwner !== null && effectiveOwner !== callerId && !isAdmin)) {

                    socket.emit("assign_chat_error", { message: "Only the currently assigned support user or an admin can transfer this chat." });
                    return;
                }
                if (targetSupportUserIds.includes(callerId)) {
                    socket.emit("assign_chat_error", { message: "You cannot assign the chat to yourself." });
                    return;
                }


                let callerUser = await SupportUser.findById(callerId).select("username email").lean();
                if (!callerUser && isAdmin) {
                    callerUser = await Admin.findById(callerId).select("username email").lean();
                }
                const callerName = callerUser?.username || callerUser?.email || (isAdmin ? "Admin" : "Support Agent");

                // Ensure all targets are strings
                const toIds = targetSupportUserIds.map(id => String(id));

                await MetadataModel.updateOne({ chatId }, {
                    $set: {
                        "pendingTransfer.fromId": callerId,
                        "pendingTransfer.requestedAt": new Date(),
                    },
                    $addToSet: {
                        "pendingTransfer.toIds": { $each: toIds }
                    }
                });

                const transferPayload = { chatId, projectId, fromId: callerId, fromName: callerName };
                const transferToken = encryptMessage(JSON.stringify(transferPayload));

                // Emit to all target personal rooms
                toIds.forEach(targetId => {
                    io.to(`user_${targetId}`).emit("transfer_request", { token: transferToken });
                });

                // ── PERSISTENT NOTIFICATION FOR TRANSFER REQUEST ──
                try {
                    const transferNotifications = toIds.map(targetId => ({
                        userId: targetId,
                        type: 'transfer_request',
                        title: 'New Transfer Request',
                        body: `${callerName} wants to transfer a chat to you.`,
                        chatId,
                        projectId,
                    }));
                    const createdTransferNotifications = await Notification.insertMany(transferNotifications);

                    // Send FCM push notifications to all target users (fire and forget)
                    for (const notif of createdTransferNotifications) {
                        sendFCMMessage(notif.userId, {
                            title: notif.title,
                            body: notif.body,
                            type: notif.type,
                            chatId: notif.chatId,
                            projectId: notif.projectId,
                            _id: notif._id
                        }).catch(console.error);
                    }
                } catch (notiErr) {
                    console.error("Error creating transfer notifications:", notiErr);
                }

                // Lookup target name for the acknowledgment toast
                let targetName = "the support user";
                if (toIds.length > 0) {
                    const firstTargetId = toIds[0];
                    const targetSupportUser = await SupportUser.findById(firstTargetId).select("username email").lean();
                    if (targetSupportUser) {
                        targetName = targetSupportUser.username || targetSupportUser.email || "the support user";
                    } else {
                        const targetAdmin = await Admin.findById(firstTargetId).select("username email").lean();
                        if (targetAdmin) {
                            targetName = targetAdmin.username || targetAdmin.email || "the support user";
                        }
                    }
                }

                const ackToken = encryptMessage(JSON.stringify({ chatId, targetSupportUserIds: toIds, targetName, status: "pending" }));
                socket.emit("assign_chat_ack", { token: ackToken });
                // Sender's "Transferred" count changes — invalidate their dashboard stats
                emitStatsInvalidated(io, callerId);

            } catch (err) {
                console.error("assign_chat error:", err);
                socket.emit("error", { message: "Failed to assign chat" });
            }
        });

        // ==================== ACCEPT TRANSFER ====================
        // ==================== ACCEPT TRANSFER ====================
        socket.on("accept_transfer", async (payload) => {
            let data = payload;
            if (payload.token) {
                try {
                    const dec = decryptMessage(payload.token);
                    data = JSON.parse(dec);
                } catch (e) { return; }
            }
            const { projectId, chatId } = data;

            try {
                if (!projectId || !chatId) {
                    socket.emit("error", { message: "Missing required fields" });
                    return;
                }

                const callerId = socket.user?.id ? String(socket.user.id) : null;
                if (!callerId) {
                    socket.emit("error", { message: "Unauthorized" });
                    return;
                }

                const project = await Project.findOne({ projectId });
                if (!project) {
                    socket.emit("error", { message: "Project not found" });
                    return;
                }

                const MetadataModel = getMetadataModel(project.collections.metadata);

                // 1. Fetch current pending invitees so we know who to notify later
                const meta = await MetadataModel.findOne({ chatId }).lean();
                if (!meta || !meta.pendingTransfer?.toIds || !meta.pendingTransfer.toIds.includes(callerId)) {
                    socket.emit("transfer_error", { message: "This chat is no longer available or was already accepted." });
                    return;
                }

                const pendingIds = meta.pendingTransfer.toIds.map(id => String(id));
                const fromId = meta.pendingTransfer.fromId ? String(meta.pendingTransfer.fromId) : null;

                // 2. Atomic update to claim the chat and clear the list
                // Push the new transfer entry into the LAST inner-array of transferHistory
                // (which represents the current query session).
                const freshMeta = await MetadataModel.findOne({ chatId }).lean();
                const sessionIdx = freshMeta?.transferHistory?.length
                    ? freshMeta.transferHistory.length - 1
                    : 0;

                const updatedMeta = await MetadataModel.findOneAndUpdate(
                    { chatId, "pendingTransfer.toIds": callerId },
                    {
                        $set: {
                            assignedTo: callerId,
                            "pendingTransfer.fromId": null,
                            "pendingTransfer.toIds": [],
                            "pendingTransfer.requestedAt": null,
                        },
                        $addToSet: { assistants: callerId },
                        $push: {
                            // Push the entry into transferHistory[sessionIdx]
                            [`transferHistory.${sessionIdx}`]: {
                                chatId,
                                fromId: fromId,
                                toId: callerId,
                                transferredAt: new Date(),
                            },
                            // Start a fresh Help Cycle for the new assignee
                            helpCycles: { startedAt: new Date() }
                        }
                    },
                    { new: true }
                );

                if (!updatedMeta) {
                    socket.emit("transfer_error", { message: "This chat was just accepted by another agent." });
                    return;
                }

                let acceptorName = "An agent";
                const acceptorUser = await SupportUser.findById(callerId).select("username email").lean();
                if (acceptorUser) {
                    acceptorName = acceptorUser.username || acceptorUser.email || "An agent";
                } else {
                    const acceptorAdmin = await Admin.findById(callerId).select("username email").lean();
                    if (acceptorAdmin) {
                        acceptorName = acceptorAdmin.username || acceptorAdmin.email || "An agent";
                    }
                }

                const acceptPayload = { chatId, projectId, newAssigneeId: callerId, acceptedByName: acceptorName };
                const acceptToken = encryptMessage(JSON.stringify(acceptPayload));

                // Notify everyone who was invited so their popups disappear instantly
                pendingIds.forEach(targetId => {
                    io.to(`user_${targetId}`).emit("transfer_accepted", { token: acceptToken });
                    emitStatsInvalidated(io, targetId);
                });

                // Also notify the general rooms
                io.to(`project_${projectId}`).emit("transfer_accepted", { token: acceptToken });
                io.to(`${projectId}_${chatId}`).emit("transfer_accepted", { token: acceptToken });
                // Invalidate stats for both the new assignee and the original sender
                emitStatsInvalidated(io, callerId);
                if (fromId) emitStatsInvalidated(io, fromId);

                // ── PERSISTENT NOTIFICATION FOR ACCEPTED TRANSFER ──
                try {
                    if (fromId) {
                        const accepterUser = await SupportUser.findById(callerId).select("username email").lean();
                        const accepterName = accepterUser?.username || accepterUser?.email || "Support Agent";

                        const newNotification = await Notification.create({
                            userId: fromId,
                            type: 'transfer_accepted',
                            title: 'Transfer Accepted',
                            body: `${accepterName} accepted your chat transfer.`,
                            chatId,
                            projectId,
                        });

                        // Send FCM push notification (fire and forget)
                        sendFCMMessage(fromId, {
                            title: newNotification.title,
                            body: newNotification.body,
                            type: newNotification.type,
                            chatId: newNotification.chatId,
                            projectId: newNotification.projectId,
                            _id: newNotification._id
                        }).catch(console.error);
                    }
                } catch (notiErr) {
                    console.error("Error creating transfer_accepted notification:", notiErr);
                }

            } catch (err) {
                console.error("accept_transfer error:", err);
                socket.emit("error", { message: "Failed to accept transfer" });
            }
        });

        // ==================== REJECT TRANSFER ====================
        socket.on("reject_transfer", async (payload) => {
            let data = payload;
            if (payload.token) {
                try {
                    const dec = decryptMessage(payload.token);
                    data = JSON.parse(dec);
                } catch (e) { return; }
            }
            const { projectId, chatId } = data;

            try {
                if (!projectId || !chatId) {
                    socket.emit("error", { message: "Missing required fields" });
                    return;
                }

                const callerId = socket.user?.id ? String(socket.user.id) : null;
                if (!callerId) {
                    socket.emit("error", { message: "Unauthorized" });
                    return;
                }

                const project = await Project.findOne({ projectId });
                if (!project) {
                    socket.emit("error", { message: "Project not found" });
                    return;
                }

                const MetadataModel = getMetadataModel(project.collections.metadata);

                // Atomic Update: Remove this specific user from the list and add to rejectedBy
                const updatedMeta = await MetadataModel.findOneAndUpdate(
                    { chatId, "pendingTransfer.toIds": callerId },
                    {
                        $pull: { "pendingTransfer.toIds": callerId },
                        $addToSet: { rejectedBy: callerId }
                    },
                    { new: true }
                );

                // Even if not found (already rejected or accepted), ack so the popup disappears
                socket.emit("transfer_rejected", { token: encryptMessage(JSON.stringify({ chatId, status: "rejected" })) });

                if (updatedMeta) {
                    const fromId = updatedMeta.pendingTransfer.fromId ? String(updatedMeta.pendingTransfer.fromId) : null;

                    if (fromId) {
                        let rejecterName = "Support Agent";
                        const rejecterSupportUser = await SupportUser.findById(callerId).select("username email").lean();
                        if (rejecterSupportUser) {
                            rejecterName = rejecterSupportUser.username || rejecterSupportUser.email || "Support Agent";
                        } else {
                            const rejecterAdmin = await Admin.findById(callerId).select("username email").lean();
                            if (rejecterAdmin) {
                                rejecterName = rejecterAdmin.username || rejecterAdmin.email || "Support Agent";
                            }
                        }

                        const isLastPerson = updatedMeta.pendingTransfer.toIds.length === 0;

                        // Notify original assigner that someone declined
                        const token = encryptMessage(JSON.stringify({
                            chatId,
                            projectId,
                            rejectedByName: rejecterName
                        }));
                        const senderSocketId = activeUsers.get(fromId);
                        if (senderSocketId) io.to(senderSocketId).emit("transfer_rejected", { token: individualToken });
                        // Invalidate stats for the rejector and the original sender
                        emitStatsInvalidated(io, callerId);
                        emitStatsInvalidated(io, fromId);

                        if (senderSocketId) {
                            io.to(senderSocketId).emit("transfer_rejected", { token });
                        }

                        // If it was the last person, clear the transfer state completely
                        if (isLastPerson) {
                            await MetadataModel.updateOne({ chatId }, {
                                $set: { "pendingTransfer.fromId": null, "pendingTransfer.requestedAt": null }
                            });

                            const finalToken = encryptMessage(JSON.stringify({
                                chatId,
                                projectId,
                                rejectedByName: "Everyone"
                            }));
                            if (senderSocketId) io.to(senderSocketId).emit("transfer_rejected", { token: finalToken });

                            // Persistent notification if everyone rejected
                            try {
                                const newNotification = await Notification.create({
                                    userId: fromId,
                                    type: 'transfer_rejected',
                                    title: 'Transfer Declined',
                                    body: `The chat transfer was declined by everyone.`,
                                    chatId,
                                    projectId,
                                });
                                // Send FCM push notification (fire and forget)
                                sendFCMMessage(fromId, {
                                    title: newNotification.title,
                                    body: newNotification.body,
                                    type: newNotification.type,
                                    chatId: newNotification.chatId,
                                    projectId: newNotification.projectId,
                                    _id: newNotification._id
                                }).catch(console.error);
                            } catch (notiErr) { }
                        } else {
                            // Notify original assigner that someone declined
                            try {
                                const newNotification = await Notification.create({
                                    userId: fromId,
                                    type: 'transfer_rejected',
                                    title: 'Transfer Declined',
                                    body: `${rejecterName} declined your chat transfer.`,
                                    chatId,
                                    projectId,
                                });
                                // Send FCM push notification (fire and forget)
                                sendFCMMessage(fromId, {
                                    title: newNotification.title,
                                    body: newNotification.body,
                                    type: newNotification.type,
                                    chatId: newNotification.chatId,
                                    projectId: newNotification.projectId,
                                    _id: newNotification._id
                                }).catch(console.error);
                            } catch (notiErr) { }
                        }
                    }
                }
            } catch (err) {
                console.error("reject_transfer error:", err);
                socket.emit("error", { message: "Failed to reject transfer" });
            }
        });

        // NOTE: dismiss_notification handler is registered below near DISMISS NOTIFICATION section.
        // (Removed duplicate simple handler — the comprehensive one handles everything)


        // ==================== LEAVE CHAT ====================
        socket.on("leave_chat", async (payload) => {
            const { projectId, chatId, userId } = payload;
            const roomKey = `${projectId}_${chatId}`;
            socket.leave(roomKey);

            // If leaving user is an assigned agent, clear assignment
            const isAgent = socket.user?.role === 'support' || socket.user?.role === 'admin';
            if (isAgent) {
                try {
                    const projectDoc = await Project.findOne({ projectId });
                    if (projectDoc && projectDoc.collections?.metadata) {
                        const MetadataModel = getMetadataModel(projectDoc.collections.metadata);
                        const agentId = String(userId);
                        const meta = await MetadataModel.findOne({ chatId }).lean();
                        if (meta && meta.assignedTo && String(meta.assignedTo) === agentId) {
                            await MetadataModel.updateOne({ chatId }, { $set: { assignedTo: null } });
                            const updatePayload = {
                                chatId,
                                projectId,
                                assignedTo: null,
                                isSilent: true
                            };
                            const updateToken = encryptMessage(JSON.stringify(updatePayload));
                            io.to(`project_${projectId}`).emit('assignment_updated', { token: updateToken });
                            io.to(roomKey).emit('assignment_updated', { token: updateToken });
                        }
                    }
                } catch (err) {
                    console.error("Error clearing assignment on leave:", err);
                }
            }

            const userLeftPayload = {
                userId: userId || socket.id,
                timestamp: new Date(),
            };
            const token = encryptMessage(JSON.stringify(userLeftPayload));

            socket.to(roomKey).emit("user_left", { token });


        });

        // ==================== DISCONNECT ====================
        socket.on("disconnect", async () => {


            // Find and remove user from active users
            for (const [userId, socketId] of activeUsers.entries()) {
                if (socketId === socket.id) {
                    activeUsers.delete(userId);
                    break;
                }
            }

            // Get room info and notify others
            const roomInfo = userRooms.get(socket.id);
            if (roomInfo) {
                const { projectId, chatId, userType, userId } = roomInfo;
                const roomKey = `${projectId}_${chatId}`;

                // If agent disconnect, clear assignment if they hold the lock
                const isAgent = userType === 'support' || userType === 'admin';
                if (isAgent) {
                    try {
                        const projectDoc = await Project.findOne({ projectId });
                        if (projectDoc && projectDoc.collections?.metadata) {
                            const MetadataModel = getMetadataModel(projectDoc.collections.metadata);
                            const meta = await MetadataModel.findOne({ chatId }).lean();
                            if (meta && meta.assignedTo && String(meta.assignedTo) === String(userId)) {
                                await MetadataModel.updateOne({ chatId }, { $set: { assignedTo: null } });
                                const updatePayload = {
                                    chatId,
                                    projectId,
                                    assignedTo: null,
                                    isSilent: true
                                };
                                const updateToken = encryptMessage(JSON.stringify(updatePayload));
                                io.to(`project_${projectId}`).emit('assignment_updated', { token: updateToken });
                                io.to(roomKey).emit('assignment_updated', { token: updateToken });
                                emitStatsInvalidated(io, userId);
                            }
                        }
                    } catch (err) {
                        console.error("Error clearing assignment on disconnect:", err);
                    }
                }

                const payload = {
                    userId: userId || socket.id,
                    timestamp: new Date(),
                };
                const token = encryptMessage(JSON.stringify(payload));

                socket.to(roomKey).emit("user_left", { token });

                // Broadcast status update to project room (for admin sidebar)
                if (userType !== "support" && userType !== "admin") {
                    const projectRoom = `project_${projectId}`;

                    // --- Connection Counting Presence Update ---
                    const sockets = chatConnections.get(chatId);
                    if (sockets) {
                        sockets.delete(socket.id);
                        if (sockets.size === 0) {
                            chatConnections.delete(chatId);

                            const statusPayload = {
                                chatId,
                                isOnline: false,
                                userId: userId
                            };
                            const statusToken = encryptMessage(JSON.stringify(statusPayload));

                            io.to(projectRoom).emit("chat_status", { token: statusToken });
                        }
                    }
                }

                userRooms.delete(socket.id);
            }
        });

        // ==================== GET ONLINE USERS ====================
        socket.on("get_online_users", (payload) => {
            const { projectId, chatId } = payload;
            const roomKey = `${projectId}_${chatId}`;
            const room = io.sockets.adapter.rooms.get(roomKey);
            const socketIds = room ? Array.from(room) : [];

            // Map socket IDs to user information
            const onlineUsers = socketIds
                .map(socketId => {
                    const roomInfo = userRooms.get(socketId);
                    if (roomInfo) {
                        return {
                            socketId,
                            userId: roomInfo.userId,
                            userType: roomInfo.userType,
                        };
                    }
                    return null;
                })
                .filter(user => user !== null);

            const onlineUsersPayload = {
                count: onlineUsers.length,
                users: onlineUsers
            };

            const encryptedOnlineUsers = encryptMessage(JSON.stringify(onlineUsersPayload));

            socket.emit("online_users", {
                token: encryptedOnlineUsers
            });
        });

        // ==================== UPDATE METADATA ====================
        socket.on("update_metadata", async (payload) => {
            const { projectId, chatId, metadata } = payload;
            try {
                // Get the metadata model for this project
                const project = await Project.findOne({ projectId });
                if (!project) {
                    socket.emit("error", { message: "Project not found" });
                    return;
                }

                const MetadataModel = getMetadataModel(project.collections.metadata);

                // HIGH-03: SECURITY — Whitelist allowed metadata fields
                const allowedFields = ["email", "name", "emailSkipped"];
                const sanitizedMetadata = {};
                for (const field of allowedFields) {
                    let val = metadata[field];
                    // Only update if value is provided and not empty
                    // This prevents overwriting with null/empty if local storage is cleared
                    if (val !== undefined && val !== null && val !== '') {
                        if (field === 'email') val = val.toLowerCase().trim();
                        if (field === 'name') val = val.trim();
                        sanitizedMetadata[field] = val;
                    }
                }

                if (Object.keys(sanitizedMetadata).length === 0) {
                    socket.emit("error", { message: "No valid metadata fields to update" });
                    return;
                }

                // Update (or CREATE) the metadata for this chat with only whitelisted fields.
                // upsert: true ensures name/email is saved even if the visitor fills the form
                // BEFORE sending their first message (when no metadata doc exists yet).
                const roomInfo = userRooms.get(socket.id);
                const storedSessionInfo = roomInfo?.initialSessionInfo || {};

                const updatedMetadata = await MetadataModel.findOneAndUpdate(
                    { chatId, projectId },
                    {
                        $set: sanitizedMetadata,
                        // Only set these base fields when INSERTING a new document
                        $setOnInsert: {
                            status: 'pending',
                            ...storedSessionInfo,
                            history: roomInfo?.initialSessionInfo ? [storedSessionInfo] : []
                        }
                    },
                    { new: true, upsert: true }
                );

                // --- Automatic Welcome Message Logic ---
                // If there are no messages in the database for this chatId yet,
                // and we just successfully identified the user (onboarding complete), 
                // prompt the welcome bot message immediately!
                const MessageModelRef = getMessageModel(project.collections.messages);
                const existingMessagesCount = await MessageModelRef.countDocuments({ chatId, projectId });

                if (existingMessagesCount === 0) {
                    const roomKey = `${projectId}_${chatId}`;

                    // Show typing indicator
                    const typingPayload = {
                        chatId,
                        userId: 'system',
                        userType: 'support',
                        isTyping: true,
                    };
                    const typingToken = encryptMessage(JSON.stringify(typingPayload));
                    io.to(roomKey).emit("user_typing", { token: typingToken });

                    // Realistic delay
                    await sleep(2000);

                    // Hide typing indicator
                    const stopTypingPayload = { ...typingPayload, isTyping: false };
                    const stopTypingToken = encryptMessage(JSON.stringify(stopTypingPayload));
                    io.to(roomKey).emit("user_typing", { token: stopTypingToken });

                    const welcomeBotMessage = new MessageModelRef({
                        projectId,
                        chatId,
                        senderType: "support",
                        senderId: "system",
                        messageType: "text",
                        message: project?.widgetConfig?.welcomeMessage || "Hello! How can we help you today?",
                        status: "sent"
                    });
                    await welcomeBotMessage.save();

                    // CLEAN THE OBJECT before encrypting
                    const welcomeMsgObj = {
                        _id: welcomeBotMessage._id,
                        projectId: welcomeBotMessage.projectId,
                        chatId: welcomeBotMessage.chatId,
                        senderType: welcomeBotMessage.senderType,
                        senderId: welcomeBotMessage.senderId,
                        messageType: welcomeBotMessage.messageType,
                        message: welcomeBotMessage.message,
                        status: welcomeBotMessage.status,
                        createdAt: welcomeBotMessage.createdAt,
                        updatedAt: welcomeBotMessage.updatedAt
                    };

                    // Encrypt and broadcast
                    const fullPayloadToken = encryptMessage(JSON.stringify(welcomeMsgObj));
                    io.to(roomKey).emit("new_message", { token: fullPayloadToken });
                    io.to(`project_${projectId}`).emit("new_message", { token: fullPayloadToken });
                }

                // Emit confirmation to the student
                const confirmPayload = { success: true, metadata: updatedMetadata };
                const confirmToken = encryptMessage(JSON.stringify(confirmPayload));
                socket.emit("metadata_updated", { token: confirmToken });

                // Also broadcast to the project room so the support sidebar updates in real-time
                if (updatedMetadata && (updatedMetadata.name || updatedMetadata.email)) {
                    const projectRoom = `project_${projectId}`;
                    const sidebarUpdatePayload = {
                        chatId,
                        name: updatedMetadata.name,
                        email: updatedMetadata.email,
                    };
                    const sidebarToken = encryptMessage(JSON.stringify(sidebarUpdatePayload));
                    io.to(projectRoom).emit("visitor_metadata_updated", { token: sidebarToken });
                }
            } catch (error) {
                console.error("Error updating metadata:", error);
                socket.emit("error", { message: "Failed to update metadata" });
            }
        });

        // ==================== RESTART CHAT ====================
        socket.on("restart_chat", async (payload) => {
            let data = payload;
            if (payload && payload.token) {
                try {
                    const decrypted = decryptMessage(payload.token);
                    data = JSON.parse(decrypted);
                } catch (err) {
                    console.error("Failed to decrypt restart_chat payload");
                    return;
                }
            }

            const { projectId, chatId, userId } = data;
            if (!projectId || !chatId) return;

            try {
                const project = await Project.findOne({ projectId });
                if (!project) return;

                const MessageModelRef = getMessageModel(project.collections.messages);
                const roomKey = `${projectId}_${chatId}`;

                // 1. Send system message "New conversation started..."
                const systemMessage = new MessageModelRef({
                    projectId,
                    chatId,
                    senderType: "system",
                    senderId: "system",
                    messageType: "text",
                    message: "New conversation started...",
                    status: "sent",
                    createdAt: new Date()
                });
                await systemMessage.save();

                // 2. Send welcome message
                const studentMessageDate = new Date();
                const welcomeBotMessage = new MessageModelRef({
                    projectId,
                    chatId,
                    senderType: "support",
                    senderId: "system",
                    messageType: "text",
                    message: project?.widgetConfig?.welcomeMessage || "Hello! How can we help you today?",
                    status: "sent",
                    createdAt: new Date(studentMessageDate.getTime() + 1000)
                });
                await welcomeBotMessage.save();

                const sysMsgObj = {
                    _id: systemMessage._id,
                    projectId: systemMessage.projectId,
                    chatId: systemMessage.chatId,
                    senderType: systemMessage.senderType,
                    senderId: systemMessage.senderId,
                    messageType: systemMessage.messageType,
                    message: systemMessage.message,
                    status: systemMessage.status,
                    createdAt: systemMessage.createdAt,
                    updatedAt: systemMessage.updatedAt
                };

                const welcomeMsgObj = {
                    _id: welcomeBotMessage._id,
                    projectId: welcomeBotMessage.projectId,
                    chatId: welcomeBotMessage.chatId,
                    senderType: welcomeBotMessage.senderType,
                    senderId: welcomeBotMessage.senderId,
                    messageType: welcomeBotMessage.messageType,
                    message: welcomeBotMessage.message,
                    status: welcomeBotMessage.status,
                    createdAt: welcomeBotMessage.createdAt,
                    updatedAt: welcomeBotMessage.updatedAt
                };

                const sysToken = encryptMessage(JSON.stringify(sysMsgObj));
                io.to(roomKey).emit("new_message", { token: sysToken });

                // restart_chat — check assignment for targeted emit
                {
                    const MetadataModelR = getMetadataModel(project.collections.metadata);
                    const chatMetaR = await MetadataModelR.findOne({ chatId }).lean();
                    const assignedToR = chatMetaR?.assignedTo ? String(chatMetaR.assignedTo) : null;

                    if (assignedToR) {
                        // ✅ Assigned — only notify the assignee
                        io.to(`user_${assignedToR}`).emit("new_message", { token: sysToken });
                    } else {
                        // ✅ Unassigned — notify everyone
                        io.to(`project_${projectId}`).emit("new_message", { token: sysToken });
                    }

                    // Show typing indicator for welcome message
                    const typingPayload = {
                        chatId,
                        userId: 'system',
                        userType: 'support',
                        isTyping: true,
                    };
                    const typingToken = encryptMessage(JSON.stringify(typingPayload));
                    io.to(roomKey).emit("user_typing", { token: typingToken });

                    // Realistic delay
                    await sleep(2000);

                    // Hide typing indicator
                    const stopTypingPayload = { ...typingPayload, isTyping: false };
                    const stopTypingToken = encryptMessage(JSON.stringify(stopTypingPayload));
                    io.to(roomKey).emit("user_typing", { token: stopTypingToken });

                    const welcomeToken = encryptMessage(JSON.stringify(welcomeMsgObj));
                    io.to(roomKey).emit("new_message", { token: welcomeToken });

                    if (assignedToR) {
                        // ✅ Assigned — only notify the assignee
                        io.to(`user_${assignedToR}`).emit("new_message", { token: welcomeToken });
                    } else {
                        // ✅ Unassigned — notify everyone
                        io.to(`project_${projectId}`).emit("new_message", { token: welcomeToken });
                    }
                }

            } catch (error) {
                console.error("Error restarting chat:", error);
            }
        });

        // ==================== DISMISS NOTIFICATION ====================
        // Per-user dismissal of the notification badge for a specific chat
        socket.on("dismiss_notification", async (payload) => {
            const tokenStr = payload.token;
            let data = payload;
            if (tokenStr) {
                try {
                    const decrypted = decryptMessage(tokenStr);
                    data = JSON.parse(decrypted);
                } catch (err) { return; }
            }

            const { projectId, chatId } = data;
            const userId = socket.user?.id ? String(socket.user.id) : null;
            if (!userId || !projectId || !chatId) return;

            try {
                const project = await Project.findOne({ projectId });
                if (!project) return;

                const MetadataModel = getMetadataModel(project.collections.metadata);
                const MessageModel = getMessageModel(project.collections.messages);

                // Add this userId to the seen-by list (idempotent)
                // AND update their last seen timestamp
                const now = new Date();
                await MetadataModel.updateOne({ chatId }, {
                    $addToSet: { notificationsSeenBy: userId },
                    $set: { [`userLastSeenAt.${userId}`]: now }
                });

                // ── CONDITIONAL GLOBAL 'SEEN' UPDATE ──────────────────────────────
                // Only mark messages as globally 'seen' if:
                // 1. The chat IS assigned to this specific user.
                // 2. OR it's unassigned and we're an admin? No, user explicitly said
                //    unassigned should stay for others. So ONLY if assigned to me.
                const meta = await MetadataModel.findOne({ chatId }).lean();
                const assignedId = meta?.assignedTo ? String(meta.assignedTo) : null;
                const origId = (meta?.originalAssignedTo &&
                    !['system', 'bot'].includes(String(meta.originalAssignedTo)))
                    ? String(meta.originalAssignedTo) : null;
                const owner = assignedId ?? origId;

                // ── CRITICAL: Only globally mark messages 'seen' for ASSIGNED chats ──
                // If we mark messages 'seen' for UNASSIGNED chats, the message count
                // in the DB drops to zero for everyone — including Support B who hasn't
                // opened the chat yet. This was causing B's badge to disappear on refresh.
                // For unassigned chats, B's badge is now maintained by the
                // lastStudentMessageAt > userLastSeenAt[B] timestamp check in unreadCounts.js.
                const chatIsAssigned = !!owner;
                if (chatIsAssigned && owner === userId) {
                    await MessageModel.updateMany(
                        { chatId, senderType: 'student', status: { $ne: 'seen' } },
                        { $set: { status: 'seen', readAt: new Date() } }
                    );
                }
                // ──────────────────────────────────────────────────────────────────

                // Confirm to the caller
                const confirmToken = encryptMessage(JSON.stringify({ chatId }));
                socket.emit("notification_dismissed", { token: confirmToken });

                // Also send a fresh unread count update to the user
                const personalizedCount = await getPersonalizedUnreadCount(project, userId, socket.user.role);
                const unreadUpdatePayload = {
                    projectId,
                    chatId,
                    type: 'read', // type 'read' zeros out the chat badge in sidebar
                    totalUnreadCount: personalizedCount,
                    unreadCount: 0
                };
                const unreadUpdateToken = encryptMessage(JSON.stringify(unreadUpdatePayload));
                socket.emit("unread_count_update", { token: unreadUpdateToken });

            } catch (error) {
                console.error("Error dismissing notification:", error);
            }
        });

        // ==================== CLEANUP ON DISCONNECT ====================
        socket.on("disconnect", () => {
            // Clean up rate limiter state to prevent memory leaks
            socketMessageTimestamps.delete(socket.id);

            // ── Presence cleanup ──────────────────────────────────────────────
            // IMPORTANT: Read roomInfo BEFORE deleting from userRooms so we
            // still have the chatId and projectId needed for the offline broadcast.
            const roomInfo = userRooms.get(socket.id);

            if (roomInfo && roomInfo.userType !== 'support' && roomInfo.userType !== 'admin') {
                const { chatId: disconnectedChatId, projectId: disconnectedProjectId } = roomInfo;

                const sockets = chatConnections.get(disconnectedChatId);
                if (sockets) {
                    sockets.delete(socket.id);

                    // No connections remain → visitor is now offline
                    if (sockets.size === 0) {
                        chatConnections.delete(disconnectedChatId);

                        const offlinePayload = {
                            chatId: disconnectedChatId,
                            isOnline: false,
                            userId: roomInfo.userId
                        };
                        const offlineToken = encryptMessage(JSON.stringify(offlinePayload));
                        io.to(`project_${disconnectedProjectId}`).emit("chat_status", { token: offlineToken });
                    }
                }
            }
            // ─────────────────────────────────────────────────────────────────

            // Clean up active user tracking
            if (socket.user && socket.user.id) {
                activeUsers.delete(String(socket.user.id));
            }
            userRooms.delete(socket.id);
        });

    });

    return io;
};



// Helper function to get active users
export const getActiveUsers = () => {
    return Array.from(activeUsers.entries());
};

// Helper function to emit to specific user
export const emitToUser = (io, userId, event, data) => {
    const socketId = activeUsers.get(userId);
    if (socketId) {
        io.to(socketId).emit(event, data);
        return true;
    }
    return false;
};

// ==================== CHAT PIN EXPIRY CRON ====================
// Runs every 60 seconds. Finds pinned chats whose pinExpiresAt has passed,
// unpins them in the DB, and pushes a `chat_pin_updated` socket event to all
// agents in the project room so every client updates instantly.
export const startChatPinExpiryCron = (io) => {
    setInterval(async () => {
        try {
            const projects = await Project.find({});
            for (const project of projects) {
                const MetadataModel = getMetadataModel(project.collections.metadata);
                const now = new Date();

                // Find all expired pinned chats for this project
                const expired = await MetadataModel.find({
                    projectId: project.projectId,
                    isPinned: true,
                    pinExpiresAt: { $ne: null, $lte: now }
                }).select('chatId').lean();

                if (expired.length > 0) {
                    const expiredIds = expired.map(m => m._id);

                    // 1. Batch unpin in DB
                    await MetadataModel.updateMany(
                        { _id: { $in: expiredIds } },
                        { $set: { isPinned: false, pinnedAt: null, pinExpiresAt: null } }
                    );

                    // 2. Broadcast to all agents watching this project
                    for (const meta of expired) {
                        const pinPayload = encryptMessage(JSON.stringify({
                            chatId: meta.chatId,
                            projectId: project.projectId,
                            isPinned: false,
                        }));
                        io.to(`project_${project.projectId}`)
                            .emit('chat_pin_updated', { token: pinPayload });
                    }
                }
            }
        } catch (err) {
            console.error('[Pin Cron] Error in chat pin expiry cron:', err);
        }
    }, 60 * 1000); // every 60 seconds
};
