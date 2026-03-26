import mongoose from "mongoose";

const webNotificationTokenSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "SupportUser",
            required: true
        },
        fcmToken: {
            type: String,
            required: true,
            unique: true
        },
        deviceInfo: {
            browser: String,
            platform: String,
            userAgent: String,
        },
        isActive: {
            type: Boolean,
            default: true
        },
        lastSeen: {
            type: Date,
            default: Date.now
        }
    },
    { timestamps: true }
);

// Index to quickly find all tokens for a user
webNotificationTokenSchema.index({ userId: 1 });

export default mongoose.models.WebNotificationToken || mongoose.model("WebNotificationToken", webNotificationTokenSchema);
