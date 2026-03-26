import bcrypt from "bcryptjs";
import Admin from "../model/Admin.js";
import { generateJWE } from "../utils/jwt.js";
import { decryptMessage, encryptMessage } from "../utils/messageEncryption.js";

// ── Account lockout constants (MED-05) ───────────────────────────────────────
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// ✅ Admin Login
export const loginAdmin = async (req, res) => {
  try {
    let { token: requestToken } = req.body;

    if (!requestToken) {
      return res.status(400).json({
        success: false,
        message: "Invalid request format",
      });
    }

    let email, password;

    try {
      const decryptedPayload = decryptMessage(requestToken);
      const parsed = JSON.parse(decryptedPayload);
      email = parsed.email;
      password = parsed.password;
    } catch (decryptError) {
      console.error("Decryption error:", decryptError);
      return res.status(400).json({
        success: false,
        message: "Invalid request format",
      });
    }

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const admin = await Admin.findOne({ email: email.toLowerCase().trim() });

    if (!admin) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // ── Account lockout check (MED-05) ───────────────────────────────────────
    if (admin.lockoutUntil && admin.lockoutUntil > new Date()) {
      const remainingMs = admin.lockoutUntil - new Date();
      const remainingMins = Math.ceil(remainingMs / 60000);
      return res.status(423).json({
        success: false,
        message: `Your account has been temporarily locked due to too many failed login attempts. Please try again in ${remainingMins} minute${remainingMins !== 1 ? "s" : ""}.`,
        lockedUntil: admin.lockoutUntil,
      });
    }

    const isMatch = await bcrypt.compare(password, admin.password);

    if (!isMatch) {
      // ── Increment failed attempts ───────────────────────────────────────────
      admin.failedLoginAttempts = (admin.failedLoginAttempts || 0) + 1;
      admin.lastFailedLogin = new Date();

      if (admin.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
        admin.lockoutUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
        admin.failedLoginAttempts = 0;
        await admin.save();
        return res.status(423).json({
          success: false,
          message: `Your account has been locked for 30 minutes after ${MAX_FAILED_ATTEMPTS} failed login attempts. Please try again later.`,
          lockedUntil: admin.lockoutUntil,
        });
      }

      await admin.save();
      const attemptsLeft = MAX_FAILED_ATTEMPTS - admin.failedLoginAttempts;
      return res.status(401).json({
        success: false,
        message: `Invalid email or password. ${attemptsLeft} attempt${attemptsLeft !== 1 ? "s" : ""} remaining before account lockout.`,
        attemptsLeft: attemptsLeft,
      });
    }

    // ── Successful login — reset lockout counters ─────────────────────────────
    admin.failedLoginAttempts = 0;
    admin.lockoutUntil = null;
    admin.lastFailedLogin = null;
    await admin.save();

    const token = await generateJWE(
      { adminId: String(admin._id), email: admin.email, role: admin.role },
      "7d"
    );

    const adminPayload = JSON.stringify({
      id: admin._id,
      username: admin.username,
      email: admin.email,
      role: admin.role,
      createdAt: admin.createdAt,
    });

    const encryptedAdmin = encryptMessage(adminPayload);

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      admin: encryptedAdmin,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// ✅ Get Logged Admin Profile (Protected)
export const getAdminProfile = async (req, res) => {
  try {
    const adminId = req.admin?.adminId;

    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const admin = await Admin.findById(adminId).select("-password");

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Admin not found",
      });
    }
    return res.status(200).json({
      success: true,
      admin,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// ✅ Update Admin FCM Token
export const updateAdminFCMToken = async (req, res) => {
  try {
    const { fcmToken, platform, appVersion } = req.body;
    const adminId = req.admin?.adminId;

    if (!adminId || !fcmToken) {
      return res.status(400).json({ success: false, message: "Admin ID and Token are required" });
    }

    const Admin = (await import('../model/Admin.js')).default;
    await Admin.findByIdAndUpdate(adminId, {
      $addToSet: { fcmTokens: fcmToken },
      $set: {
        'deviceInfo.platform': platform || 'unknown',
        'deviceInfo.appVersion': appVersion || '1.0.0',
        'deviceInfo.lastSeen': new Date()
      }
    });

    return res.status(200).json({ success: true, message: "FCM token registered" });
  } catch (error) {
    console.error("FCM Token update error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ✅ Remove Admin FCM Token
export const removeAdminFCMToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;
    const adminId = req.admin?.adminId;

    if (!adminId || !fcmToken) {
      return res.status(400).json({ success: false, message: "Admin ID and Token are required" });
    }

    const Admin = (await import('../model/Admin.js')).default;
    await Admin.findByIdAndUpdate(adminId, {
      $pull: { fcmTokens: fcmToken }
    });

    return res.status(200).json({ success: true, message: "FCM token removed" });
  } catch (error) {
    console.error("FCM Token removal error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};



