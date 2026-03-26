import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
    {
        projectId: {
            type: String,
            required: true,
            index: true,
        },

        chatId: {
            type: String,
            required: true,
            index: true,
        },

        senderType: {
            type: String,
            enum: ["student", "support", "admin", "system"],
            required: true,
        },

        senderId: {
            type: String,
            default: null,
        },

        messageType: {
            type: String,
            enum: ["text", "image", "file"],
            default: "text",
        },

        message: {
            type: String,
            default: "",
        },

        // For file/image messages
        fileUrl: {
            type: String,
            default: null,
        },

        fileName: {
            type: String,
            default: null,
        },

        status: {
            type: String,
            enum: ["sent", "delivered", "seen"],
            default: "sent",
        },

        // Timestamp when message was read
        readAt: {
            type: Date,
            default: null,
        },

        // For reply functionality
        replyTo: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
        },

        isDeleted: {
            type: Boolean,
            default: false,
        },

        // For "Delete for me" functionality
        deletedBy: {
            type: [String], // Array of senderIds who deleted this message for themselves
            default: [],
        },

        isEdited: {
            type: Boolean,
            default: false,
        },

        editedAt: {
            type: Date,
            default: null,
        },
        isPinned: {
            type: Boolean,
            default: false,
        },
        pinnedAt: {
            type: Date,
            default: null,
        },
        pinExpiresAt: {
            type: Date,
            default: null,
        },
        isBold: {
            type: Boolean,
            default: false,
        },
        reactions: [
            {
                emoji: { type: String, required: true },
                senderId: { type: String, required: true },
                senderType: { type: String, enum: ["student", "support", "admin", "system"], required: true },
                createdAt: { type: Date, default: Date.now },
            }
        ],
        showRating: {
            type: Boolean,
            default: false
        },
    },
    { timestamps: true }
);

// Compound indexes for better query performance
messageSchema.index({ chatId: 1, createdAt: -1 }); // For fetching chat messages
messageSchema.index({ projectId: 1, chatId: 1 }); // For project-specific queries

export const getMessageModel = (collectionName) => {
    if (!collectionName) {
        throw new Error("collectionName is required for getMessageModel()");
    }

    return (
        mongoose.models[collectionName] ||
        mongoose.model(collectionName, messageSchema, collectionName)
    );
};
