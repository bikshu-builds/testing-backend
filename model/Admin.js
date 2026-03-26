import mongoose from "mongoose";

const adminSchema = new mongoose.Schema(
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
      default: "ADMIN",
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

export default mongoose.models.Admin || mongoose.model("Admin", adminSchema);
