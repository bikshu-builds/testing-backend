import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'SupportUser',
            required: true,
            index: true
        },
        type: {
            type: String,
            required: true,
            enum: ['transfer_request', 'new_message', 'transfer_accepted', 'transfer_rejected', 'chat_status_changed', 'assign_chat']
        },
        title: {
            type: String,
            required: true
        },
        body: {
            type: String,
            required: true
        },
        chatId: {
            type: String,
            default: null
        },
        projectId: {
            type: String,
            default: null
        },
        read: {
            type: Boolean,
            default: false,
            index: true
        },
        createdAt: {
            type: Date,
            default: Date.now,
            expires: 604800 // Automatically delete after 7 days
        }
    },
    { timestamps: true }
);

const Notification = mongoose.model("Notification", notificationSchema);

export default Notification;
