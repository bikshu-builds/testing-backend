import { verifyJWE, verifyStudentJWE } from "../utils/jwt.js";
import Admin from "../model/Admin.js";
import SupportUser from "../model/supportUser.js";

/**
 * Middleware to authenticate Admin, Support User, or Student (Widget User).
 * Handles JWE tokens for staff and JWE tokens for students.
 */
export const authAll = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Authorization header missing or invalid",
            });
        }

        const token = authHeader.split(" ")[1];

        // 1. Try to verify as JWE (Admin or Support User)
        try {
            const decoded = await verifyJWE(token);

            if (decoded.adminId) {
                const admin = await Admin.findById(decoded.adminId);
                if (admin) {
                    req.admin = {
                        adminId: admin._id,
                        username: admin.username,
                        email: admin.email,
                    };
                    req.userType = "admin";
                    return next();
                }
            }

            if (decoded.id) {
                const supportUser = await SupportUser.findById(decoded.id);
                if (supportUser) {
                    if (!supportUser.isActive) {
                        return res.status(403).json({
                            success: false,
                            message: "Account deactivated",
                        });
                    }
                    req.supportUser = {
                        id: supportUser._id,
                        username: supportUser.username,
                        email: supportUser.email,
                        role: supportUser.role,
                    };
                    req.userType = "support";
                    return next();
                }
            }
        } catch (jweError) {
            // Not a valid worker JWE, might be a student JWE
        }

        // 2. Try to verify as Student JWE
        try {
            const studentData = await verifyStudentJWE(token);
            if (studentData) {
                // Basic integrity check: must have projectId and chatId
                if (studentData.projectId && studentData.chatId) {
                    req.student = studentData;
                    req.userType = "student";
                    return next();
                }
            }
        } catch (jweError) {
            // Both verification methods failed
        }

        return res.status(401).json({
            success: false,
            message: "Invalid or expired session",
        });
    } catch (error) {
        console.error("authAll error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal server error during authentication",
        });
    }
};
