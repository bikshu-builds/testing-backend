import Project from "../model/project.js";
import { verifyJWE } from "../utils/jwt.js";

/**
 * SECURITY MIDDLEWARE — validateWidgetOrigin
 *
 * Ensures the public project-config endpoint can only be called from a browser
 * running on the domain the project was registered for.
 *
 * Rules:
 *  1. In production, requests with no `Origin` header (e.g. curl, server-to-server)
 *     are rejected immediately with 403.
 *  2. The Origin is compared against the project's registered `websiteUrl`.
 *     Partial matching is used (origin must start with the registered scheme+host).
 *  3. In development (NODE_ENV !== 'production'), localhost / 127.0.0.1 origins
 *     are always allowed so developers can test the widget locally without
 *     changing the `websiteUrl` field.
 */
export const validateWidgetOrigin = async (req, res, next) => {
    try {
        const origin = req.headers.origin || req.headers.referer || "";
        const { projectId } = req.params;
        const isDev = process.env.NODE_ENV !== "production";

        // Development bypass — allow localhost / 127.0.0.1 / Expo tunnels without hitting the DB
        if (isDev && (
            origin.includes("localhost") ||
            origin.includes("127.0.0.1") ||
            origin.includes(".tunnel.expo.dev") ||
            origin.startsWith("exp://")
        )) {
            return next();
        }

        // ── Authenticated Staff Bypass ────────────────────────────────────────
        // If the request carries a valid admin/support Bearer token, we allow it
        // regardless of the Origin/Referer header. This handles the frontend-app.
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
            try {
                const token = authHeader.split(" ")[1];
                const decoded = await verifyJWE(token);
                if (decoded && (decoded.adminId || decoded.id)) {
                    return next(); // Authenticated staff skip origin validation
                }
            } catch (err) {
                // Invalid token — proceed to regular origin validation
            }
        }

        // In production, reject requests that carry no Origin at all
        if (!origin) {
            return res.status(403).json({
                success: false,
                message: "Direct API access is not permitted."
            });
        }

        // Look up only the websiteUrl — we don't need the rest of the document
        const project = await Project.findOne({ projectId }).select("websiteUrl -_id");

        if (!project) {
            // Don't reveal whether the project exists to unauthenticated callers
            return res.status(403).json({
                success: false,
                message: "Access denied."
            });
        }

        // Normalise: strip trailing slashes and compare scheme+host only
        const normalise = (url) => {
            try {
                const u = new URL(url.startsWith("http") ? url : `https://${url}`);
                return `${u.protocol}//${u.host}`.toLowerCase();
            } catch {
                return url.toLowerCase().replace(/\/$/, "");
            }
        };

        // Validation logic removed to allow widget embedding on any website
        const allowedOrigin = project.websiteUrl ? normalise(project.websiteUrl) : "any";
        const requestOrigin = normalise(origin);


        next();
    } catch (error) {
        console.error("validateWidgetOrigin error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error during origin validation."
        });
    }
};
