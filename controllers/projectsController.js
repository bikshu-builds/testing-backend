import Project from "../model/project.js";
import crypto from "crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import s3Client from "../config/s3.js";
import { getFileAsBase64 } from "../utils/s3Helper.js";
import { getPersonalizedUnreadCount } from "../utils/unreadCounts.js";



// ✅ Create New Project
export const createProject = async (req, res) => {
    try {
        const { projectName, websiteUrl, companyUrl, widgetConfig, emailSetting } = req.body;

        // Basic Validation
        if (!projectName || !websiteUrl) {
            return res.status(400).json({
                success: false,
                message: "Project Name and Website URL are required"
            });
        }

        // 1. Generate Unique Project ID
        const projectId = crypto.randomBytes(6).toString("hex"); // e.g., "a1b2c3d4e5f6"

        // 2. Define Isolated Collection Names
        const collections = {
            supportUsers: `support_users_${projectId}`,
            metadata: `metadata_${projectId}`,
            messages: `messages_${projectId}`
        };

        // 3. Generate Student Side Widget Snippet
        // Note: This URL should point to where your widget script is hosted.
        // For now, using a placeholder based on the server URL.
        const baseUrl = process.env.BASE_URL || "http://localhost:5000";
        const studentSideWidget = `<script src="${baseUrl}/api/widget/bundle.js" data-project-id="${projectId}"></script>`;

        // 4. Create Project
        const newProject = await Project.create({
            projectId,
            projectName,
            websiteUrl,
            companyUrl,
            collections,
            widgetConfig: widgetConfig || {}, // Use defaults if not provided
            emailSetting: emailSetting || {
                collectEmails: true,
                isEmailMandatory: true,
                emailMessage: 'Please enter your email to start chatting with our support team',
                deleteSkippedAfterDays: 7
            },
            snippets: {
                studentSideWidget
            }
        });

        return res.status(201).json({
            success: true,
            message: "Project created successfully",
            project: newProject
        });

    } catch (error) {
        console.error("createProject error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while creating project",
            error: error.message
        });
    }
};

// ✅ Get All Projects (For Admin Dashboard)
// ✅ Get All Projects (For Admin Dashboard)
export const getAllProjects = async (req, res) => {
    try {
        const projectsRaw = await Project.find().sort({ createdAt: -1 });

        // Process projects to include Base64 logos and unread counts
        const userId = req.admin?.adminId || req.supportUser?.id;
        const role = req.admin ? 'admin' : 'support';

        const projects = await Promise.all(projectsRaw.map(async (p) => {
            const project = p.toObject();

            // 1. Logos
            if (project.widgetConfig?.logoUrl) {
                project.widgetConfig.logoUrl = await getFileAsBase64(project.widgetConfig.logoUrl);
            }
            if (project.widgetConfig?.supportLogoUrl) {
                project.widgetConfig.supportLogoUrl = await getFileAsBase64(project.widgetConfig.supportLogoUrl);
            }

            // 2. Unread Count
            try {
                project.unreadCount = await getPersonalizedUnreadCount(project, userId, role);
            } catch (err) {
                console.error(`Error fetching unreadCount for project ${project.projectId}:`, err);
                project.unreadCount = 0;
            }

            return project;
        }));

        return res.status(200).json({
            success: true,
            count: projects.length,
            projects
        });
    } catch (error) {
        console.error("getAllProjects error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while fetching projects"
        });
    }
};

// ✅ Get Project By ID
export const getProjectById = async (req, res) => {
    try {
        const { id } = req.params;
        const project = await Project.findById(id);

        if (!project) {
            return res.status(404).json({
                success: false,
                message: "Project not found"
            });
        }

        const projectData = project.toObject();

        if (projectData.widgetConfig?.logoUrl) {
            // Keep original URL for saving, send Base64 for preview
            projectData.widgetConfig.logoPreview = await getFileAsBase64(projectData.widgetConfig.logoUrl);
        }

        if (projectData.widgetConfig?.supportLogoUrl) {
            // Keep original URL for saving, send Base64 for preview
            projectData.widgetConfig.supportLogoPreview = await getFileAsBase64(projectData.widgetConfig.supportLogoUrl);
        }

        return res.status(200).json({
            success: true,
            project: projectData
        });
    } catch (error) {
        console.error("getProjectById error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while fetching project details"
        });
    }
};

// ✅ Get Public Project Config (For Widget)
// SECURITY: Only exposes the minimum fields required to render the chat widget.
// Sensitive fields (projectName, websiteUrl, companyUrl, emailSetting.deleteSkippedAfterDays,
// snippets, collections, DB timestamps/IDs) are intentionally excluded.
export const getPublicProjectConfig = async (req, res) => {
    try {
        const { projectId } = req.params;

        // Fetch only the fields we actually need — defence-in-depth against future schema additions
        const project = await Project.findOne({ projectId }).select(
            "widgetConfig emailSetting.collectEmails emailSetting.isEmailMandatory emailSetting.emailMessage reviewConfig -_id"
        );

        if (!project) {
            return res.status(404).json({
                success: false,
                message: "Project not found"
            });
        }

        const raw = project.toObject();

        // Convert S3 logos to Base64 so they render instantly on client sites (no CORS on S3 URLs)
        if (raw.widgetConfig?.logoUrl) {
            raw.widgetConfig.logoUrl = await getFileAsBase64(raw.widgetConfig.logoUrl);
        }
        if (raw.widgetConfig?.supportLogoUrl) {
            raw.widgetConfig.supportLogoUrl = await getFileAsBase64(raw.widgetConfig.supportLogoUrl);
        }

        // Build an explicit, safe response — never forward the raw DB document directly
        const safeResponse = {
            widgetConfig: {
                theme: raw.widgetConfig?.theme,
                primaryColor: raw.widgetConfig?.primaryColor,
                headerTextColor: raw.widgetConfig?.headerTextColor,
                headerText: raw.widgetConfig?.headerText,
                position: raw.widgetConfig?.position,
                logoUrl: raw.widgetConfig?.logoUrl,
                supportLogoUrl: raw.widgetConfig?.supportLogoUrl,
                welcomeMessage: raw.widgetConfig?.welcomeMessage,
                companyName: raw.widgetConfig?.companyName,
                logoParams: raw.widgetConfig?.logoParams,
                productNameSize: raw.widgetConfig?.productNameSize,
                productNameX: raw.widgetConfig?.productNameX,
                productNameY: raw.widgetConfig?.productNameY,
            },
            reviewConfig: raw.reviewConfig,
            emailSetting: {
                collectEmails: raw.emailSetting?.collectEmails,
                isEmailMandatory: raw.emailSetting?.isEmailMandatory,
                emailMessage: raw.emailSetting?.emailMessage,
            }
        };

        return res.status(200).json({
            success: true,
            project: safeResponse
        });
    } catch (error) {
        console.error("getPublicProjectConfig error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
};

// ✅ Update Project
export const updateProject = async (req, res) => {
    try {
        const { id } = req.params;

        // SECURITY: Whitelist only safe, updatable fields to prevent mass assignment
        const allowedFields = [
            "projectName", "websiteUrl", "companyUrl",
            "widgetConfig", "emailSetting", "reviewConfig"
        ];
        const updates = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                success: false,
                message: "No valid fields to update"
            });
        }

        const project = await Project.findByIdAndUpdate(id, updates, { new: true });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: "Project not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Project updated successfully",
            project
        });

    } catch (error) {
        console.error("updateProject error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while updating project"
        });
    }
};

// ✅ Delete Project
export const deleteProject = async (req, res) => {
    try {
        const { id } = req.params;
        const project = await Project.findByIdAndDelete(id);

        if (!project) {
            return res.status(404).json({
                success: false,
                message: "Project not found"
            });
        }

        // TODO: Drop the dynamic collections associated with this project (supportUsers, messages, etc.)
        // For now, we just delete the project record.

        return res.status(200).json({
            success: true,
            message: "Project deleted successfully"
        });

    } catch (error) {
        console.error("deleteProject error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while deleting project"
        });
    }
};
