import { verifyJWE } from "../utils/jwt.js";
import SupportUser from "../model/supportUser.js";

export const authSupportUser = async (req, res, next) => {
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

        // Check if support user still exists and is active
        const supportUser = await SupportUser.findById(decoded.id);

        if (!supportUser) {
            return res.status(401).json({
                success: false,
                message: "User not found",
                accountStatus: "deleted",
            });
        }

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

        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: "Invalid or expired token",
        });
    }
};
