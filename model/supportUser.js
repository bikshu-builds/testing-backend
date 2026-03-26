import mongoose from "mongoose";

const supportUserSchema = new mongoose.Schema(
    {
        username: {
            type: String,
            required: true,
            trim: true,
        },

        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
        },

        password: {
            type: String,
            required: true,
        },

        role: {
            type: String,
            default: "SUPPORT_USER",
            immutable: true, // role change cheyyakudadhu
        },

        isActive: {
            type: Boolean,
            default: true,
        },

        createdByAdminId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Admin",
            required: true,
        },

        // ── Account lockout (MED-05) ──────────────────────────────
        failedLoginAttempts: {
            type: Number,
            default: 0,
        },

        lockoutUntil: {
            type: Date,
            default: null,
        },

        lastFailedLogin: {
            type: Date,
            default: null,
        },

        // ── Password Reset (OTP) ──────────────────────────────────
        resetPasswordOTP: {
            type: String,
            default: null,
        },

        resetPasswordExpires: {
            type: Date,
            default: null,
        },

        // ── FCM Push Notifications ──────────────────────────────────
        fcmTokens: [{
            type: String,
            default: []
        }],

        deviceInfo: {
            platform: String,
            appVersion: String,
            lastSeen: Date
        }
    },
    { timestamps: true }
);

export default mongoose.models.SupportUser || mongoose.model("SupportUser", supportUserSchema);
