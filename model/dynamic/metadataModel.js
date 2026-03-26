
import mongoose from "mongoose";

const metadataSchema = new mongoose.Schema(
    {
        projectId: {
            type: String,
            required: true,
            index: true,
        },

        chatId: {
            type: String,
            required: true,
            unique: true, // Metadata is unique per chat session
            index: true,
        },

        userId: {
            type: String,
            default: null,
        },

        // Student contact info (controlled by project emailSetting)
        email: {
            type: String,
            default: null,
            index: true,
        },
        name: { type: String, default: null },
        emailSkipped: {
            type: Boolean,
            default: false
        },

        // Device and session metadata
        browser: { type: String, default: null },
        os: { type: String, default: null },
        device: { type: String, default: null },
        status: {
            type: String,
            enum: ["pending", "resolved", "unresolved"],
            default: "pending",
            index: true,
        },
        // History of sessions
        history: [
            {
                ip: { type: String, default: null },
                location: { type: String, default: null },
                isp: { type: String, default: null },
                browser: { type: String, default: null },
                os: { type: String, default: null },
                device: { type: String, default: null },
                screenResolution: { type: String, default: null },
                language: { type: String, default: null },
                referrer: { type: String, default: null },
                currentUrl: { type: String, default: null },
                timestamp: { type: Date, default: Date.now },
            }
        ],
        isPinned: {
            type: Boolean,
            default: false,
            index: true,
        },
        isDeleted: {
            type: Boolean,
            default: false,
            index: true,
        },

        // When the chat was pinned
        pinnedAt: {
            type: Date,
            default: null,
        },

        // Optional expiry — null means "pinned forever"
        pinExpiresAt: {
            type: Date,
            default: null,
            index: true, // indexed so the cron query is fast
        },

        // ==================== CHAT OWNERSHIP ====================
        // The ORIGINAL first support user to be assigned — never changes
        originalAssignedTo: {
            type: String,
            default: null,
        },

        // The CURRENTLY ACTIVE support user (latest transfer acceptee)
        assignedTo: {
            type: String,
            default: null,
        },

        // All previous active users who lost control (assisted role) — current session only
        assistants: {
            type: [String],
            default: [],
        },

        // Permanent audit trail of assistants across all sessions (array of arrays).
        // assistantHistory[0] = session-0 assistants, [1] = session-1, etc.
        // On auto-unresolve the current assistants[] is pushed here before being cleared.
        assistantHistory: {
            type: [[String]],
            default: [],
        },

        // Permanent audit trail of the original assignee per session (array of arrays).
        // originalAssigneeHistory[0] = session-0 original assignee, [1] = session-1, etc.
        // Each inner array holds one entry: { agentId, agentName, chatId, assignedAt }
        // On resolve, the current session entry is archived here and originalAssignedTo is cleared.
        originalAssigneeHistory: {
            type: [[{
                agentId: { type: String },
                agentName: { type: String },
                chatId: { type: String },
                assignedAt: { type: Date, default: Date.now }
            }]],
            default: [],
        },

        // Pending transfer request (multiple recipients supported)
        pendingTransfer: {
            fromId: { type: String, default: null },
            toIds: { type: [String], default: [] },
            requestedAt: { type: Date, default: null }
        },

        // Users who explicitly rejected the transfer for this specific chat
        rejectedBy: {
            type: [String],
            default: [],
        },

        // History of all transfers — array of arrays.
        // Each inner array is one "query session".
        // When a resolved chat gets a new student message a fresh [] is pushed,
        // and subsequent transfers in that session are appended to that inner array.
        // transferHistory[0] = first query's transfers, transferHistory[1] = second query's, etc.
        transferHistory: {
            type: [[{
                chatId: { type: String },            // which chat was transferred
                fromId: { type: String },            // who initiated the transfer
                toId: { type: String },            // who accepted the transfer
                transferredAt: { type: Date, default: Date.now }
            }]],
            default: [[]],   // start with one empty session
        },

        // Full audit trail — every resolve event is pushed here (never wiped).
        // resolvedBy[0] = first resolution, resolvedBy[1] = second resolution, etc.
        resolvedBy: [
            {
                userId: { type: String },
                username: { type: String },
                chatId: { type: String },
                resolvedAt: { type: Date, default: Date.now },
                durationString: { type: String },
            }
        ],

        // History of all ratings given in the chat
        ratings: [
            {
                rating: { type: Number, min: 1, max: 5 },
                chatId: { type: String },
                userId: { type: String, default: null }, // Support user ID
                username: { type: String, default: null }, // Support user Name
                ratedAt: { type: Date, default: Date.now }
            }
        ],

        // ==================== RECURRING CHAT SESSIONS ====================
        // Tracks individual session "cycles" for accurate speed measurements.
        // A new cycle starts when a chat is created, or when a student
        // messages in a previously "resolved" chat.
        helpCycles: [
            {
                startedAt: { type: Date, default: null }, // When cycle opened
                pickedUpAt: { type: Date, default: null }, // First agent reply
                pickedUpBy: { type: String, default: null }, // Agent ID
                resolvedAt: { type: Date, default: null }, // When cycle ended
                resolvedBy: { type: String, default: null }, // Resolver username
            }
        ],

        // ==================== PER-USER NOTIFICATION TRACKING ====================
        // Array of userIds (support agents / admins) who have seen/dismissed
        // the notification for the LATEST student message.
        // Reset to [] each time a new student message arrives.
        notificationsSeenBy: {
            type: [String],
            default: [],
        },

        // Timestamp of the last student message — used by front-end to
        // decide whether to show or hide the notification badge.
        lastStudentMessageAt: {
            type: Date,
            default: null,
        },

        lastMessageDetails: {
            timestamp: { type: Date, default: null },
            senderRole: { type: String, enum: ["student", "support", "admin", "system", null], default: null },
            chatId: { type: String, default: null },
            activeAssigneeAtTimeOfMessage: { type: String, default: null }
        },

        // Map of userId -> lastSeenTimestamp for each support agent/admin
        // Used to calculate individual unread counts correctly.
        userLastSeenAt: {
            type: Map,
            of: Date,
            default: {},
        },
        isDeleted: {
            type: Boolean,
            default: false,
            index: true,
        },
        // Count of resolutions that have not been rated yet
        pendingRatingCount: {
            type: Number,
            default: 0
        },
        // Whether a rating has been explicitly requested for the current cycle
        ratingRequested: {
            type: Boolean,
            default: false
        },
        // Whether a review has been explicitly requested for the current cycle
        reviewRequested: {
            type: Boolean,
            default: false
        },
        // Rating submitted via support-requested flow (before or without resolution)
        latestRating: {
            type: Number,
            default: null,
            min: 1,
            max: 5
        },
    },
    { timestamps: true }
);

// SPEED-UP: Index for fast lookup of latest conversation by email
metadataSchema.index({ email: 1, updatedAt: -1 });

export const getMetadataModel = (collectionName) => {
    if (!collectionName) {
        throw new Error("collectionName is required for getMetadataModel()");
    }

    return (
        mongoose.models[collectionName] ||
        mongoose.model(collectionName, metadataSchema, collectionName)
    );
};
