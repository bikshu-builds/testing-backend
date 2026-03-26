import { verifyJWE } from "../utils/jwt.js";
import Admin from "../model/Admin.js";
import SupportUser from "../model/supportUser.js";

/**
 * Middleware to authenticate either Admin or Support User.
 * Decrypts the JWE token, then resolves the identity from the claims.
 */
export const authAdminOrSupportUser = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader) {
            return res.status(401).json({
                success: false,
                message: "Authorization header missing",
            });
        }

        if (!authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Invalid token format. Use: Bearer <token>",
            });
        }

        const token = authHeader.split(" ")[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "Token missing",
            });
        }

        // Decrypt JWE — verifies AES-GCM auth tag (integrity) and exp claim
        const decoded = await verifyJWE(token);

        // Try to find admin first (admin tokens carry adminId)
        if (decoded.adminId) {
            const admin = await Admin.findById(decoded.adminId);
            if (admin) {
                req.admin = {
                    adminId: admin._id,
                    username: admin.username,
                    email: admin.email,
                };
                return next();
            }
        }

        // Try support user (support tokens carry id + type: "SUPPORT_USER")
        if (decoded.id) {
            const supportUser = await SupportUser.findById(decoded.id);
            if (supportUser) {
                if (!supportUser.isActive) {
                    return res.status(403).json({
                        success: false,
                        message: "Your account has been deactivated. Please contact admin.",
                        accountStatus: "inactive",
                    });
                }

                req.supportUser = {
                    id: supportUser._id,
                    username: supportUser.username,
                    email: supportUser.email,
                    role: supportUser.role,
                };
                return next();
            }
        }

        // Neither admin nor support user found
        return res.status(401).json({
            success: false,
            message: "User not found",
        });
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: "Invalid or expired token",
        });
    }
};
