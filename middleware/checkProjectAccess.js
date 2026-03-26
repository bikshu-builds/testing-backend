import ProjectSupportUser from "../model/ProjectSupportUser.js";
import Project from "../model/project.js";

/**
 * Middleware to check if the authenticated support user has access to a specific project.
 * Admins are automatically granted access.
 */
export const checkProjectAccess = async (req, res, next) => {
    try {
        // Admins have access to all projects
        if (req.admin) {
            return next();
        }

        // Support users must be assigned to the project
        if (req.supportUser) {
            const { projectId } = req.params;

            if (!projectId) {
                return next();
            }

            // 1. Find the project by its string projectId
            const project = await Project.findOne({ projectId }).select('_id');
            if (!project) {
                return res.status(404).json({
                    success: false,
                    message: "Project not found",
                });
            }

            // 2. Check if a dynamic assignment exists and is active
            const assignment = await ProjectSupportUser.findOne({
                projectId: project._id,
                supportUserId: req.supportUser.id,
                isActive: true
            });

            if (!assignment) {
                return res.status(403).json({
                    success: false,
                    message: "Access Denied: You are not assigned to this project.",
                });
            }

            return next();
        }

        // For student/visitor or other cases, move to next middleware (authAll handles student vs support)
        return next();
    } catch (error) {
        console.error("Error in checkProjectAccess middleware:", error);
        return res.status(500).json({
            success: false,
            message: "Internal server error during access verification",
        });
    }
};
