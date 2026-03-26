import bcrypt from "bcryptjs";
import SupportUser from "../model/supportUser.js";
import ProjectSupportUser from "../model/ProjectSupportUser.js";
import Project from "../model/project.js";
import { getMetadataModel } from "../model/dynamic/metadataModel.js";
import { getMessageModel } from "../model/dynamic/messageModel.js";
import { generateJWE } from "../utils/jwt.js";
import { decryptMessage, encryptMessageCBC as encryptMessage } from "../utils/messageEncryption.js";
import Notification from "../model/Notification.js";
import { emitToUser } from "../sockets/chatHandlers.js";
import { getFileAsBase64 } from "../utils/s3Helper.js";
import { sendOTPEmail } from "../utils/mailHelper.js";
import { registerFCMToken, unregisterFCMToken } from "../utils/fcmService.js";
import WebNotificationToken from "../model/WebNotificationToken.js";

// Helper to generate 6-char alphanumeric OTP
const generateOTP = () => {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let otp = "";
    for (let i = 0; i < 6; i++) {
        otp += chars[Math.floor(Math.random() * chars.length)];
    }
    return otp;
};

// ── Account lockout constants (MED-05) ───────────────────────────────────────
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 minutes


// ==============================
// 1) Create Support User (ADMIN)
// ==============================
export const createSupportUser = async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({
                success: false,
                message: "username, email, password are required",
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 8 characters long.",
            });
        }

        // check already exists
        const existing = await SupportUser.findOne({ email: email.toLowerCase() });
        if (existing) {
            return res.status(409).json({
                success: false,
                message: "Support user already exists with this email",
            });
        }

        // hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const supportUser = await SupportUser.create({
            username,
            email: email.toLowerCase(),
            password: hashedPassword,
            createdByAdminId: req.admin.adminId, // from admin auth middleware (JWT contains adminId)
        });


        return res.status(201).json({
            success: true,
            message: "Support user created successfully",
            supportUser: {
                _id: supportUser._id,
                username: supportUser.username,
                email: supportUser.email,
                role: supportUser.role,
                isActive: supportUser.isActive,
                createdAt: supportUser.createdAt,
            },
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server error",
        });
    }
};

// ==============================
// 2) Support User Login
// ==============================
export const supportUserLogin = async (req, res) => {
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
                message: "email and password are required",
            });
        }

        const supportUser = await SupportUser.findOne({
            email: email.toLowerCase(),
        });

        if (!supportUser) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password",
            });
        }

        if (!supportUser.isActive) {
            return res.status(403).json({
                success: false,
                message: "Your account is inactive. Contact admin.",
            });
        }

        // ── Account lockout check (MED-05) ───────────────────────────────────
        if (supportUser.lockoutUntil && supportUser.lockoutUntil > new Date()) {
            const remainingMs = supportUser.lockoutUntil - new Date();
            const remainingMins = Math.ceil(remainingMs / 60000);
            return res.status(423).json({
                success: false,
                message: `Your account has been temporarily locked due to too many failed login attempts. Please try again in ${remainingMins} minute${remainingMins !== 1 ? "s" : ""}.`,
                lockedUntil: supportUser.lockoutUntil,
            });
        }

        const isMatch = await bcrypt.compare(password, supportUser.password);
        if (!isMatch) {
            // ── Increment failed attempts ─────────────────────────────────────
            supportUser.failedLoginAttempts = (supportUser.failedLoginAttempts || 0) + 1;
            supportUser.lastFailedLogin = new Date();

            if (supportUser.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
                supportUser.lockoutUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
                supportUser.failedLoginAttempts = 0;
                await supportUser.save();
                return res.status(423).json({
                    success: false,
                    message: `Your account has been locked for 30 minutes after ${MAX_FAILED_ATTEMPTS} failed login attempts. Please try again later.`,
                    lockedUntil: supportUser.lockoutUntil,
                });
            }

            await supportUser.save();
            const attemptsLeft = MAX_FAILED_ATTEMPTS - supportUser.failedLoginAttempts;
            return res.status(401).json({
                success: false,
                message: `Invalid email or password. ${attemptsLeft} attempt${attemptsLeft !== 1 ? "s" : ""} remaining before account lockout.`,
                attemptsLeft: attemptsLeft,
            });
        }

        // ── Successful login — reset lockout counters ─────────────────────────
        supportUser.failedLoginAttempts = 0;
        supportUser.lockoutUntil = null;
        supportUser.lastFailedLogin = null;
        await supportUser.save();
        const token = await generateJWE(
            { id: String(supportUser._id), role: supportUser.role, type: "SUPPORT_USER" },
            "7d"
        );

        const userPayload = JSON.stringify({
            _id: supportUser._id,
            username: supportUser.username,
            email: supportUser.email,
            role: supportUser.role,
        });

        const encryptedUser = encryptMessage(userPayload);

        return res.status(200).json({
            success: true,
            message: "Login successful",
            token,
            user: encryptedUser,
        });
    } catch (error) {

        return res.status(500).json({
            success: false,
            message: "Server error",
        });
    }
};

// ==============================
// 3) Get All Support Users (ADMIN)
// ==============================
export const getAllSupportUsers = async (req, res) => {
    try {
        const users = await SupportUser.find({ createdByAdminId: req.admin.adminId })
            .select("-password")
            .sort({ createdAt: -1 });


        return res.status(200).json({
            success: true,
            supportUsers: users,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server error",
        });
    }
};

// ==============================
// 4) DELETE Support User (Admin Only)
// ==============================
export const deleteSupportUser = async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "User ID is required",
            });
        }

        // Check if the support user exists and was created by this admin
        const supportUser = await SupportUser.findOne({
            _id: userId,
            createdByAdminId: req.admin.adminId,
        });

        if (!supportUser) {
            return res.status(404).json({
                success: false,
                message: "Support user not found or you don't have permission to delete this user",
            });
        }

        await SupportUser.findByIdAndDelete(userId);

        return res.status(200).json({
            success: true,
            message: "Support user deleted successfully",
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server error",
        });
    }
};

// ==============================
// 5) UPDATE Support User Password (Admin Only)
// ==============================
export const updateSupportUserPassword = async (req, res) => {
    try {
        const { userId } = req.params;
        const { newPassword } = req.body;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "User ID is required",
            });
        }

        if (!newPassword || newPassword.length < 8) {
            return res.status(400).json({
                success: false,
                message: "New password is required and must be at least 8 characters.",
            });
        }

        // Check if the support user exists and was created by this admin
        const supportUser = await SupportUser.findOne({
            _id: userId,
            createdByAdminId: req.admin.adminId,
        });

        if (!supportUser) {
            return res.status(404).json({
                success: false,
                message: "Support user not found or you don't have permission to update this user",
            });
        }

        // Hash the new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Update the password
        supportUser.password = hashedPassword;
        await supportUser.save();

        return res.status(200).json({
            success: true,
            message: "Password updated successfully",
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server error",
        });
    }
};

// ==============================
// 6) TOGGLE Support User Active Status (Admin Only)
// ==============================
export const toggleSupportUserStatus = async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "User ID is required",
            });
        }

        // Check if the support user exists and was created by this admin
        const supportUser = await SupportUser.findOne({
            _id: userId,
            createdByAdminId: req.admin.adminId,
        });

        if (!supportUser) {
            return res.status(404).json({
                success: false,
                message: "Support user not found or you don't have permission to update this user",
            });
        }

        // Toggle the active status
        supportUser.isActive = !supportUser.isActive;
        await supportUser.save();

        // If user is deactivated, force logout via socket
        if (!supportUser.isActive) {
            try {
                const io = req.app.get("io");
                if (io) {
                    const payload = {
                        userId: String(supportUser._id),
                        action: 'logout',
                        reason: 'account_deactivated'
                    };
                    const token = encryptMessage(JSON.stringify(payload));
                    emitToUser(io, String(supportUser._id), "account_deactivated", { token });
                }
            } catch (socketErr) {
                console.error("Error emitting logout event:", socketErr);
            }
        }

        return res.status(200).json({
            success: true,
            message: `Support user ${supportUser.isActive ? 'activated' : 'deactivated'} successfully`,
            user: {
                _id: supportUser._id,
                username: supportUser.username,
                email: supportUser.email,
                isActive: supportUser.isActive,
            },
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server error",
        });
    }
};

// ==============================
// 7) CHECK Support User Status (For logged-in users)
// ==============================
export const checkSupportUserStatus = async (req, res) => {
    try {
        // This endpoint uses authSupportUser middleware
        // If we reach here, user is active and valid
        return res.status(200).json({
            success: true,
            isActive: true,
            user: req.supportUser,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Server error',
        });
    }
};

// ==============================
// 7.1) Get Support User Profile
// ==============================
export const getSupportUserProfile = async (req, res) => {
    try {
        // req.supportUser is populated by authSupportUser middleware
        const user = await SupportUser.findById(req.supportUser.id).select("-password -resetPasswordOTP -resetPasswordExpires");

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        return res.status(200).json({ success: true, user });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==============================
// 7.2) Request Password Reset OTP
// ==============================
export const requestPasswordResetOTP = async (req, res) => {
    try {
        const user = await SupportUser.findById(req.supportUser.id);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const otp = generateOTP();
        const expires = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes

        user.resetPasswordOTP = otp;
        user.resetPasswordExpires = expires;
        await user.save();

        const emailSent = await sendOTPEmail(user.email, otp);

        if (!emailSent) {
            return res.status(500).json({ success: false, message: "Failed to send OTP email" });
        }

        return res.status(200).json({ success: true, message: "OTP sent to your email" });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==============================
// 7.3) Verify Password Reset OTP
// ==============================
export const verifyPasswordResetOTP = async (req, res) => {
    try {
        const { otp } = req.body;
        if (!otp) {
            return res.status(400).json({ success: false, message: "OTP is required" });
        }

        const user = await SupportUser.findById(req.supportUser.id);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (user.resetPasswordOTP !== otp || user.resetPasswordExpires < new Date()) {
            return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
        }

        return res.status(200).json({ success: true, message: "OTP verified successfully" });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==============================
// 7.4) Reset Password with OTP
// ==============================
export const resetPasswordWithOTP = async (req, res) => {
    try {
        const { otp, newPassword } = req.body;

        if (!otp || !newPassword || newPassword.length < 8) {
            return res.status(400).json({
                success: false,
                message: "OTP and a new password (min 8 characters) are required",
            });
        }

        const user = await SupportUser.findById(req.supportUser.id);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (user.resetPasswordOTP !== otp || user.resetPasswordExpires < new Date()) {
            return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
        }

        // Hash new password
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);

        // Clear OTP fields
        user.resetPasswordOTP = null;
        user.resetPasswordExpires = null;
        await user.save();

        return res.status(200).json({ success: true, message: "Password reset successfully" });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Server error" });
    }
};
// ==============================
// 8) GET Support User Count (ADMIN)
// ==============================
export const getSupportUserCount = async (req, res) => {
    try {
        const count = await SupportUser.countDocuments({
            createdByAdminId: req.admin.adminId,
        });

        return res.status(200).json({
            success: true,
            count,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server error",
        });
    }
};

// ==============================
// 9) GET Support Users By Project (Support + Admin)
// Returns active support users assigned to a project — used by the Assign/Transfer UI
// ==============================
export const getSupportUsersByProject = async (req, res) => {
    try {
        const { projectId } = req.params;

        if (!projectId) {
            return res.status(400).json({ success: false, message: "projectId is required" });
        }

        // Find the project by projectId string
        const project = await Project.findOne({ projectId });
        if (!project) {
            return res.status(404).json({ success: false, message: "Project not found" });
        }

        // Find all active assignments for this project
        const assignments = await ProjectSupportUser.find({
            projectId: project._id,
            isActive: true,
        }).populate({ path: "supportUserId", select: "_id username email isActive" });

        // Filter out inactive support users
        const supportUsers = assignments
            .filter(a => a.supportUserId && a.supportUserId.isActive)
            .map(a => ({
                _id: a.supportUserId._id,
                username: a.supportUserId.username,
                email: a.supportUserId.email,
            }));

        return res.status(200).json({ success: true, supportUsers });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==============================
// 10) GET Support User Stats (ADMIN)
// ==============================
export const getSupportUserStats = async (req, res) => {
    try {
        const { userId } = req.params;
        const { period = 'all', startDate, endDate } = req.query;

        // Security check
        const targetUserId = String(userId);
        const callerId = req.admin ? null : String(req.supportUser?.id);
        if (!req.admin && callerId !== targetUserId) {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }

        const assignments = await ProjectSupportUser.find({ supportUserId: targetUserId, isActive: true }).populate('projectId').lean();
        if (!assignments.length) {
            return res.status(200).json({ success: true, stats: { totalAssignedProducts: 0, topProjects: [] } });
        }

        const now = new Date();
        const startOfToday = new Date(now);
        startOfToday.setHours(0, 0, 0, 0);

        const startOfYesterday = new Date(now);
        startOfYesterday.setDate(now.getDate() - 1);
        startOfYesterday.setHours(0, 0, 0, 0);
        const endOfYesterday = new Date(now);
        endOfYesterday.setDate(now.getDate() - 1);
        endOfYesterday.setHours(23, 59, 59, 999);

        let filterStartDate = null;
        let filterEndDate = null;

        if (startDate) {
            const [y, m, d] = startDate.split('-').map(Number);
            filterStartDate = new Date(y, m - 1, d, 0, 0, 0, 0);
            if (endDate) {
                const [ey, em, ed] = endDate.split('-').map(Number);
                filterEndDate = new Date(ey, em - 1, ed, 23, 59, 59, 999);
            } else {
                filterEndDate = new Date(y, m - 1, d, 23, 59, 59, 999);
            }
        } else if (period === 'today') {
            filterStartDate = startOfToday;
        } else if (period === 'yesterday') {
            filterStartDate = startOfYesterday;
            filterEndDate = endOfYesterday;
        } else if (period === 'week') {
            filterStartDate = new Date(now);
            filterStartDate.setDate(now.getDate() - 7);
        } else if (period === 'month') {
            filterStartDate = new Date(now);
            filterStartDate.setMonth(now.getMonth() - 1);
        }

        const twelveDaysAgo = new Date(now);
        twelveDaysAgo.setDate(twelveDaysAgo.getDate() - 11);
        twelveDaysAgo.setHours(0, 0, 0, 0);

        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay());
        weekStart.setHours(0, 0, 0, 0);

        // Variables for global averages
        let totalResTime = 0;
        let resCountWithTime = 0;
        let totalPickupTime = 0;
        let pickupCountWithStats = 0;

        const globalResolutionVolume = Array(12).fill(0);
        const globalAssignedVolume = Array(12).fill(0);
        const globalWeeklyEngagement = Array(7).fill(0);
        const globalRatingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

        const projectStatsPromises = assignments.map(async (assignment) => {
            const project = assignment.projectId;
            if (!project || !project.collections || !project.collections.metadata) return null;

            try {
                const MetadataModel = getMetadataModel(project.collections.metadata);
                const MessageModel = getMessageModel(project.collections.messages);

                const dateRangeFilter = {};
                if (filterStartDate) dateRangeFilter.$gte = filterStartDate;
                if (filterEndDate) dateRangeFilter.$lte = filterEndDate;

                const hasFilter = Object.keys(dateRangeFilter).length > 0;

                // --- 1. Faceted Aggregation for Counts ---
                const countPipeline = [
                    {
                        $facet: {
                            assignedInPeriod: [
                                {
                                    $match: {
                                        $or: [
                                            { assignedTo: targetUserId },
                                            { assignedTo: null, originalAssignedTo: targetUserId }
                                        ],
                                        ...(hasFilter ? { createdAt: dateRangeFilter } : {})
                                    }
                                },
                                { $count: "count" }
                            ],
                            assignedLifetime: [
                                {
                                    $match: {
                                        $or: [
                                            { assignedTo: targetUserId },
                                            { assignedTo: null, originalAssignedTo: targetUserId }
                                        ]
                                    }
                                },
                                { $count: "count" }
                            ],
                            // resolvedBy is now an ARRAY — use $unwind so we can count
                            // *every single time* (index-wise!) this user resolved the chat.
                            resolvedInPeriod: [
                                { $unwind: { path: "$resolvedBy", preserveNullAndEmptyArrays: false } },
                                {
                                    $match: {
                                        "resolvedBy.userId": targetUserId,
                                        ...(hasFilter ? { "resolvedBy.resolvedAt": dateRangeFilter } : {})
                                    }
                                },
                                { $count: "count" }
                            ],
                            activeAssistedInPeriod: [
                                { $match: { assistants: targetUserId, ...(hasFilter ? { updatedAt: dateRangeFilter } : {}) } },
                                { $count: "count" }
                            ],
                            historicalAssistedInPeriod: [
                                { $match: { ...(hasFilter ? { "resolvedBy.resolvedAt": dateRangeFilter } : {}) } },
                                { $unwind: { path: "$assistantHistory", preserveNullAndEmptyArrays: false } },
                                { $unwind: { path: "$assistantHistory", preserveNullAndEmptyArrays: false } },
                                { $match: { "assistantHistory": targetUserId } },
                                { $count: "count" }
                            ],
                            unresolvedAssigned: [
                                {
                                    $match: {
                                        $or: [
                                            { assignedTo: targetUserId },
                                            { assignedTo: null, originalAssignedTo: targetUserId }
                                        ],
                                        status: { $ne: "resolved" }
                                    }
                                },
                                { $count: "count" }
                            ],
                            unresolvedAssisted: [
                                { $match: { assistants: targetUserId, status: { $ne: "resolved" } } },
                                { $count: "count" }
                            ],
                            chatsReceived: [
                                { $match: { isDeleted: { $ne: true }, ...(hasFilter ? { createdAt: dateRangeFilter } : {}) } },
                                { $count: "count" }
                            ],
                            unresolvedCreatedInPeriod: [
                                { $match: { status: { $ne: "resolved" }, ...(hasFilter ? { createdAt: dateRangeFilter } : {}) } },
                                { $count: "count" }
                            ],
                            totalResolutionsInPeriod: [
                                { $unwind: { path: "$resolvedBy", preserveNullAndEmptyArrays: false } },
                                {
                                    $match: {
                                        ...(hasFilter ? { "resolvedBy.resolvedAt": dateRangeFilter } : {})
                                    }
                                },
                                { $count: "count" }
                            ],
                            // transferHistory is now array-of-arrays — unwind twice to get flat entries
                            transfersSent: [
                                { $unwind: { path: "$transferHistory", preserveNullAndEmptyArrays: false } },
                                { $unwind: { path: "$transferHistory", preserveNullAndEmptyArrays: false } },
                                { $match: { "transferHistory.fromId": String(userId), ...(hasFilter ? { "transferHistory.transferredAt": dateRangeFilter } : {}) } },
                                { $count: "count" }
                            ],
                            transfersAccepted: [
                                { $unwind: { path: "$transferHistory", preserveNullAndEmptyArrays: false } },
                                { $unwind: { path: "$transferHistory", preserveNullAndEmptyArrays: false } },
                                { $match: { "transferHistory.toId": String(userId), ...(hasFilter ? { "transferHistory.transferredAt": dateRangeFilter } : {}) } },
                                { $count: "count" }
                            ],
                            ratingsInPeriod: [
                                { $unwind: { path: "$ratings", preserveNullAndEmptyArrays: false } },
                                {
                                    $match: {
                                        "ratings.userId": targetUserId,
                                        ...(hasFilter ? { "ratings.ratedAt": dateRangeFilter } : {})
                                    }
                                },
                                {
                                    $group: {
                                        _id: null,
                                        avgRating: { $avg: "$ratings.rating" },
                                        ratingCount: { $sum: 1 }
                                    }
                                }
                            ],
                            ratingDistribution: [
                                { $unwind: { path: "$ratings", preserveNullAndEmptyArrays: false } },
                                {
                                    $match: {
                                        "ratings.userId": targetUserId,
                                        ...(hasFilter ? { "ratings.ratedAt": dateRangeFilter } : {})
                                    }
                                },
                                {
                                    $group: {
                                        _id: "$ratings.rating",
                                        count: { $sum: 1 }
                                    }
                                }
                            ]
                        }
                    }
                ];

                const facetedRes = await MetadataModel.aggregate(countPipeline);
                const counts = facetedRes[0];
                const getC = (key) => counts[key]?.[0]?.count || 0;

                const resolvedCount = getC('resolvedInPeriod');
                const assistedCount = getC('activeAssistedInPeriod') + getC('historicalAssistedInPeriod');
                const unresolvedCount = getC('unresolvedAssigned');

                // Total Chats = sum of all participation events (Resolutions + Assistance sessions + Current Assignments)
                const chatsReceived = resolvedCount + assistedCount + unresolvedCount;

                const projectAvgRating = counts.ratingsInPeriod?.[0]?.avgRating || 0;
                const projectRatingCount = counts.ratingsInPeriod?.[0]?.ratingCount || 0;

                const projectRatingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
                (counts.ratingDistribution || []).forEach(item => {
                    const rating = Math.round(item._id);
                    if (rating >= 1 && rating <= 5) {
                        projectRatingDistribution[rating] = item.count;
                        globalRatingDistribution[rating] += item.count;
                    }
                });

                // --- 2. Chart Volume and Engagement ---
                // Filter docs where this user resolved at least once recently OR was assigned recently
                const volumePipeline = [
                    {
                        $match: {
                            $or: [
                                { resolvedBy: { $elemMatch: { userId: targetUserId, resolvedAt: { $gte: twelveDaysAgo } } } },
                                { assignedTo: targetUserId, createdAt: { $gte: twelveDaysAgo } },
                                { assignedTo: null, originalAssignedTo: targetUserId, createdAt: { $gte: twelveDaysAgo } }
                            ]
                        }
                    },
                    {
                        $project: {
                            // Keep all resolvedBy entries for this user in the last 12 days
                            myResolutions: {
                                $filter: {
                                    input: { $ifNull: ["$resolvedBy", []] },
                                    as: "r",
                                    cond: {
                                        $and: [
                                            { $eq: ["$$r.userId", targetUserId] },
                                            { $gte: ["$$r.resolvedAt", twelveDaysAgo] }
                                        ]
                                    }
                                }
                            },
                            isAssigned: {
                                $or: [
                                    { $eq: ["$assignedTo", targetUserId] },
                                    {
                                        $and: [
                                            { $eq: ["$assignedTo", null] },
                                            { $eq: ["$originalAssignedTo", targetUserId] }
                                        ]
                                    }
                                ]
                            },
                            createdAt: "$createdAt"
                        }
                    }
                ];
                const volumeDocs = await MetadataModel.aggregate(volumePipeline);

                const projectDailyVolume = Array(12).fill(0);
                const projectAssignedVolume = Array(12).fill(0);

                volumeDocs.forEach(doc => {
                    // One resolved entry per resolution event
                    (doc.myResolutions || []).forEach(r => {
                        const diff = Math.floor((new Date(r.resolvedAt) - twelveDaysAgo) / 86400000);
                        if (diff >= 0 && diff < 12) {
                            projectDailyVolume[diff]++;
                            globalResolutionVolume[diff]++;
                        }
                    });
                    if (doc.isAssigned && doc.createdAt >= twelveDaysAgo) {
                        const diff = Math.floor((new Date(doc.createdAt) - twelveDaysAgo) / 86400000);
                        if (diff >= 0 && diff < 12) {
                            projectAssignedVolume[diff]++;
                            globalAssignedVolume[diff]++;
                        }
                    }
                });

                // Engagement (Weekly) — unwind resolvedBy array so each entry is its own doc
                const engagementDocs = await MetadataModel.aggregate([
                    { $match: { resolvedBy: { $elemMatch: { userId: targetUserId, resolvedAt: { $gte: weekStart } } } } },
                    { $unwind: "$resolvedBy" },
                    { $match: { "resolvedBy.userId": targetUserId, "resolvedBy.resolvedAt": { $gte: weekStart } } },
                    { $project: { day: { $dayOfWeek: "$resolvedBy.resolvedAt" } } }
                ]);
                engagementDocs.forEach(doc => {
                    const idx = doc.day - 1; // 1 (Sun) to 7 (Sat) -> 0 to 6
                    globalWeeklyEngagement[idx]++;
                });

                // --- 3. Averages (Pickup & Resolution Speed) ---
                // We query helpCycles for these.
                const resTimeDocs = await MetadataModel.aggregate([
                    { $match: { helpCycles: { $elemMatch: { resolvedBy: targetUserId, ...(hasFilter ? { resolvedAt: dateRangeFilter } : {}) } } } },
                    { $unwind: "$helpCycles" },
                    { $match: { "helpCycles.resolvedBy": targetUserId, ...(hasFilter ? { "helpCycles.resolvedAt": dateRangeFilter } : {}) } },
                    { $project: { duration: { $subtract: ["$helpCycles.resolvedAt", "$helpCycles.startedAt"] } } },
                ]);
                const projectTotalResTime = resTimeDocs.reduce((sum, doc) => sum + (doc.duration > 0 ? doc.duration : 0), 0);
                const projectResCount = resTimeDocs.filter(doc => doc.duration > 0).length;
                totalResTime += (projectTotalResTime / 60000); // Minutes
                resCountWithTime += projectResCount;

                // Same pattern as Resolution Time, query helpCycles directly for pickup metrics
                const pickupTimeDocs = await MetadataModel.aggregate([
                    { $match: { helpCycles: { $elemMatch: { pickedUpBy: targetUserId, ...(hasFilter ? { pickedUpAt: dateRangeFilter } : {}) } } } },
                    { $unwind: "$helpCycles" },
                    { $match: { "helpCycles.pickedUpBy": targetUserId, "helpCycles.pickedUpAt": { $ne: null }, ...(hasFilter ? { "helpCycles.pickedUpAt": dateRangeFilter } : {}) } },
                    { $project: { duration: { $subtract: ["$helpCycles.pickedUpAt", "$helpCycles.startedAt"] } } },
                ]);
                const projectTotalPickupMs = pickupTimeDocs.reduce((sum, doc) => sum + (doc.duration > 0 ? doc.duration : 0), 0);
                const projectPickupCount = pickupTimeDocs.filter(doc => doc.duration > 0).length;
                totalPickupTime += (projectTotalPickupMs / 60000); // Minutes
                pickupCountWithStats += projectPickupCount;

                // --- 5. Unread Count ---
                const activeChatIds = await MetadataModel.find({ status: { $ne: 'resolved' } }).distinct('chatId');
                let unreadCount = 0;
                if (activeChatIds.length > 0) {
                    unreadCount = await MessageModel.countDocuments({
                        chatId: { $in: activeChatIds },
                        senderType: 'student',
                        status: { $ne: 'seen' },
                        isDeleted: false
                    });
                }

                // Logo processing (Parallelized)
                let logoUrl = project.widgetConfig?.supportLogoUrl || project.widgetConfig?.logoUrl;
                if (logoUrl) logoUrl = await getFileAsBase64(logoUrl);

                return {
                    name: project.projectName,
                    projectId: project.projectId,
                    logoUrl,
                    chatsReceived,
                    resolved: getC('resolvedInPeriod'),
                    assigned: getC('assignedInPeriod'),
                    assignedLifetime: getC('assignedLifetime'),
                    assisted: assistedCount,
                    transferred: getC('transfersSent'),
                    accepted: getC('transfersAccepted'),
                    pending: getC('unresolvedAssigned'),
                    unresolvedAssisted: getC('unresolvedAssisted'),
                    unreadCount,
                    avgResolutionTime: projectResCount > 0 ? (projectTotalResTime / projectResCount / 60000) : 0,
                    avgPickupTime: projectPickupCount > 0 ? (projectTotalPickupMs / 60000 / projectPickupCount) : 0,
                    avgRating: projectAvgRating,
                    ratingCount: projectRatingCount,
                    ratingDistribution: projectRatingDistribution,
                    dailyVolume: projectDailyVolume,
                    assignedVolume: projectAssignedVolume
                };

            } catch (err) {
                console.error(`[Stats] Project ${assignment.projectId?.projectId} error:`, err.message);
                return null;
            }
        });

        const topProjectsRaw = await Promise.all(projectStatsPromises);
        const topProjects = topProjectsRaw.filter(p => p !== null).sort((a, b) => b.resolved - a.resolved);

        const stats = {
            totalAssignedProducts: assignments.length,
            totalAssignedChats: topProjects.reduce((a, p) => a + p.assigned, 0),
            totalResolvedChats: topProjects.reduce((a, p) => a + p.resolved, 0),
            totalAssistedChats: topProjects.reduce((a, p) => a + p.assisted, 0),
            unresolvedAssignedChats: topProjects.reduce((a, p) => a + p.pending, 0),
            unresolvedAssistedChats: topProjects.reduce((a, p) => a + (p.unresolvedAssisted || 0), 0),
            totalTransferredChats: topProjects.reduce((a, p) => a + p.transferred, 0),
            totalAcceptedTransfers: topProjects.reduce((a, p) => a + p.accepted, 0),
            todayDate: startOfToday.toISOString().split('T')[0],
            yesterdayDate: startOfYesterday.toISOString().split('T')[0],
            resolutionVolume: globalResolutionVolume,
            assignedVolume: globalAssignedVolume,
            weeklyEngagement: globalWeeklyEngagement,
            topProjects,
            averageResolutionTime: resCountWithTime > 0 ? (totalResTime * 60000 / resCountWithTime / 60000) : 0, // In minutes
            averageAssignmentTime: pickupCountWithStats > 0 ? (totalPickupTime / pickupCountWithStats) : 0, // Still using "AssignmentTime" key for frontend compatibility
            averageRating: topProjects.reduce((a, p) => a + (p.avgRating * p.ratingCount), 0) / (topProjects.reduce((a, p) => a + p.ratingCount, 0) || 1),
            ratingDistribution: globalRatingDistribution
        };

        return res.status(200).json({ success: true, stats });

    } catch (error) {
        console.error("getSupportUserStats error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==============================
// 11) UNLOCK Support User Account (Admin Only — MED-05)
// ==============================
export const unlockSupportUser = async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).json({ success: false, message: "User ID is required" });
        }

        const supportUser = await SupportUser.findOne({
            _id: userId,
            createdByAdminId: req.admin.adminId,
        });

        if (!supportUser) {
            return res.status(404).json({
                success: false,
                message: "Support user not found or you don't have permission to unlock this user",
            });
        }

        supportUser.failedLoginAttempts = 0;
        supportUser.lockoutUntil = null;
        supportUser.lastFailedLogin = null;
        await supportUser.save();

        return res.status(200).json({
            success: true,
            message: `Account for ${supportUser.email} has been unlocked successfully.`,
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Server error" });
    }
};
// ==============================
// 12) UPDATE Support User (Admin Only)
// ==============================
export const updateSupportUser = async (req, res) => {
    try {
        const { userId } = req.params;
        const { username, email, password } = req.body;

        if (!userId) {
            return res.status(400).json({ success: false, message: "User ID is required" });
        }

        // Check if the support user exists and was created by this admin
        const supportUser = await SupportUser.findOne({
            _id: userId,
            createdByAdminId: req.admin.adminId,
        });

        if (!supportUser) {
            return res.status(404).json({
                success: false,
                message: "Support user not found or you don't have permission to update this user",
            });
        }

        // Update username if provided
        if (username) supportUser.username = username;

        // Update email if provided and check for duplicates
        if (email) {
            const normalizedEmail = email.toLowerCase();
            if (normalizedEmail !== supportUser.email) {
                const existingUser = await SupportUser.findOne({ email: normalizedEmail });
                if (existingUser) {
                    return res.status(400).json({ success: false, message: "Email already in use" });
                }
                supportUser.email = normalizedEmail;
            }
        }

        // Update password if provided
        if (password) {
            if (password.length < 8) {
                return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
            }
            const salt = await bcrypt.genSalt(10);
            supportUser.password = await bcrypt.hash(password, salt);
        }

        await supportUser.save();

        return res.status(200).json({
            success: true,
            message: "Support user updated successfully",
            user: {
                _id: supportUser._id,
                username: supportUser.username,
                email: supportUser.email,
                isActive: supportUser.isActive,
            },
        });
    } catch (error) {
        console.error("updateSupportUser error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};
// ==============================
// 19) Get Notifications
// ==============================
export const getNotifications = async (req, res) => {
    try {
        const supportUserId = req.supportUser?.id;
        if (!supportUserId) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        const notifications = await Notification.find({
            userId: supportUserId,
            read: false
        }).sort({ createdAt: -1 }).limit(50).lean();

        // Encrypt notifications for transport
        const encrypted = encryptMessage(JSON.stringify(notifications));

        return res.status(200).json({
            success: true,
            data: encrypted
        });
    } catch (error) {
        console.error("getNotifications error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==============================
// 20) Mark Notifications as Read
// ==============================
export const markNotificationsRead = async (req, res) => {
    try {
        const supportUserId = req.supportUser?.id;
        const { notificationIds } = req.body;

        if (!supportUserId) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }


        const query = { userId: supportUserId };

        if (notificationIds && Array.isArray(notificationIds)) {
            if (notificationIds.length === 0) {
                // Empty array passed, do nothing
                return res.status(200).json({ success: true, message: "No notifications to mark" });
            }

            // Clean up IDs (frontend sometimes sends them wrapped in extra quotes due to stringify issues)
            const cleanIds = notificationIds.map(id => typeof id === 'string' ? id.replace(/^"|"$/g, '') : '');

            // Filter out valid 24-character MongoDB ObjectIds.
            const validMongoIds = cleanIds.filter(id => /^[a-fA-F0-9]{24}$/.test(id));

            // Extract chat IDs from the temporary frontend "new_message" IDs
            const chatIdsToMarkRead = cleanIds
                .filter(id => id.startsWith('new_message_'))
                .map(id => {
                    const stripped = id.replace('new_message_', '');
                    const lastUnderscore = stripped.lastIndexOf('_');
                    return lastUnderscore > 0 ? stripped.substring(0, lastUnderscore) : stripped;
                });

            if (validMongoIds.length === 0 && chatIdsToMarkRead.length === 0) {
                // Not valid format for either scenario
                return res.status(200).json({ success: true, message: "Notifications marked as read (frontend local only)" });
            }

            // Construct the database match conditions
            const orConditions = [];
            if (validMongoIds.length > 0) {
                orConditions.push({ _id: { $in: validMongoIds } });
            }
            if (chatIdsToMarkRead.length > 0) {
                // Also update persistent database entries tied to these chats
                orConditions.push({ chatId: { $in: chatIdsToMarkRead }, type: 'new_message' });
            }

            if (orConditions.length === 1) {
                Object.assign(query, orConditions[0]);
            } else if (orConditions.length > 1) {
                query.$or = orConditions;
            }
        } else if (notificationIds && !Array.isArray(notificationIds)) {
            // Invalid format for notificationIds
            return res.status(400).json({ success: false, message: "Invalid notificationIds format" });
        }
        // If notificationIds is undefined, it skips the above IF and marks ALL as read for the user

        await Notification.updateMany(query, { $set: { read: true } });

        return res.status(200).json({
            success: true,
            message: "Notifications marked as read"
        });
    } catch (error) {
        console.error("markNotificationsRead error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==============================
// 21) Register FCM Token
// ==============================
export const updateFCMToken = async (req, res) => {
    try {
        const supportUserId = req.supportUser?.id;
        const { token: requestToken } = req.body;

        if (!supportUserId) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        if (!requestToken) {
            return res.status(400).json({ success: false, message: "Request token required" });
        }

        let fcmToken, platform, appVersion, deviceInfo;
        try {
            const decryptedPayload = decryptMessage(requestToken);
            const parsed = JSON.parse(decryptedPayload);
            fcmToken = parsed.fcmToken;
            platform = parsed.platform;
            appVersion = parsed.appVersion;
            deviceInfo = parsed.deviceInfo;
        } catch (decryptError) {
            console.error("FCM Token decryption error:", decryptError);
            return res.status(400).json({ success: false, message: "Invalid request format" });
        }

        if (!fcmToken) {
            return res.status(400).json({ success: false, message: "FCM token required" });
        }

        if (platform === 'web') {
            // Save to the NEW dedicated WebNotificationToken model
            await WebNotificationToken.findOneAndUpdate(
                { fcmToken },
                { 
                    userId: supportUserId, 
                    deviceInfo: platform === 'web' ? { browser: 'web' } : {},
                    lastSeen: new Date(),
                    isActive: true
                },
                { upsert: true, new: true }
            );
        } else {
            // Original logic for Mobile Apps (stays in SupportUser model)
            await registerFCMToken(supportUserId, fcmToken, platform, appVersion);
        }

        return res.status(200).json({ success: true, message: "FCM token updated" });
    } catch (error) {
        console.error("updateFCMToken error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==============================
// 22) Remove FCM Token
// ==============================
export const removeFCMToken = async (req, res) => {
    try {
        const supportUserId = req.supportUser?.id;
        const { fcmToken } = req.body;

        if (!supportUserId) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        if (fcmToken) {
            await unregisterFCMToken(supportUserId, fcmToken);
        } else {
            // Remove all tokens if none specified
            await SupportUser.findByIdAndUpdate(supportUserId, {
                fcmTokens: [],
                deviceInfo: null
            });
            fcmTokenCache.delete(supportUserId);
        }

        return res.status(200).json({ success: true, message: "FCM token removed" });
    } catch (error) {
        console.error("removeFCMToken error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==============================
// 23) Unauthenticated Forgot Password Request OTP
// ==============================
export const forgotPasswordRequestOTP = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, message: "Email is required" });
        }

        const user = await SupportUser.findOne({ email: email.toLowerCase() });
        if (!user) {
            // Do not reveal if user exists or not for security, but we return 404 for UX
            return res.status(404).json({ success: false, message: "No account found with this email" });
        }

        if (!user.isActive) {
            return res.status(403).json({ success: false, message: "Your account is deactivated. Contact your administrator." });
        }

        const otp = generateOTP();
        
        user.resetPasswordOTP = otp;
        user.resetPasswordExpires = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes
        await user.save();

        const emailSent = await sendOTPEmail(user.email, otp);
        if (!emailSent) {
            user.resetPasswordOTP = null;
            user.resetPasswordExpires = null;
            await user.save();
            return res.status(500).json({ success: false, message: "Failed to send email. Try again later." });
        }

        return res.status(200).json({ success: true, message: "OTP sent successfully to your email." });
    } catch (error) {
        console.error("forgotPasswordRequestOTP error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==============================
// 24) Unauthenticated Forgot Password Verify OTP
// ==============================
export const forgotPasswordVerifyOTP = async (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) {
            return res.status(400).json({ success: false, message: "Email and OTP are required" });
        }

        const user = await SupportUser.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (user.resetPasswordOTP !== otp || user.resetPasswordExpires < new Date()) {
            return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
        }

        return res.status(200).json({ success: true, message: "OTP verified successfully" });
    } catch (error) {
        console.error("forgotPasswordVerifyOTP error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==============================
// 25) Unauthenticated Forgot Password Reset
// ==============================
export const forgotPasswordResetPassword = async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;
        if (!email || !otp || !newPassword || newPassword.length < 8) {
            return res.status(400).json({
                success: false,
                message: "Email, OTP, and a new password (min 8 characters) are required",
            });
        }

        const user = await SupportUser.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (user.resetPasswordOTP !== otp || user.resetPasswordExpires < new Date()) {
            return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);

        // Clear OTP fields
        user.resetPasswordOTP = null;
        user.resetPasswordExpires = null;
        
        // Unlock account if locked out
        user.failedLoginAttempts = 0;
        user.lockoutUntil = null;
        user.lastFailedLogin = null;
        
        await user.save();

        return res.status(200).json({ success: true, message: "Password reset successfully. You can now log in." });
    } catch (error) {
        console.error("forgotPasswordResetPassword error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};
