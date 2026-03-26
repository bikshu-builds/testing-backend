import mongoose from "mongoose";
import ProjectSupportUser from "../model/ProjectSupportUser.js";
import SupportUser from "../model/supportUser.js";
import Admin from "../model/Admin.js";
import Project from "../model/project.js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import s3Client from "../config/s3.js";
import { getMessageModel } from "../model/dynamic/messageModel.js";
import { getMetadataModel } from "../model/dynamic/metadataModel.js";
import { emitToUser } from "../sockets/chatHandlers.js";
import { encryptMessageCBC as encryptMessage } from "../utils/messageEncryption.js";
import { getPersonalizedUnreadCount } from "../utils/unreadCounts.js";


// ==================== HELPER FUNCTION ====================
/**
 * Get S3 File as Base64 Data URI
 */
const getFileAsBase64 = async (url) => {
    if (!url || typeof url !== 'string' || !url.includes('amazonaws.com')) return url;
    try {
        // Extract key
        const parts = url.split('.amazonaws.com/');
        if (parts.length < 2) return url;
        const key = parts[1];

        // 

        const command = new GetObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET,
            Key: key,
        });

        const response = await s3Client.send(command);
        const stream = response.Body;

        // Convert stream to buffer
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        // Determine mime type
        const mimeType = response.ContentType || 'image/png';

        return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch (e) {
        console.error(`[ERROR] Failed to fetch S3 logo for URL: ${url}`, e.message);
        return url; // Fallback to URL if fetch fails
    }
};

// ==============================
// 1) ASSIGN Support User to Project (Admin Only)
// ==============================
export const assignSupportUserToProject = async (req, res) => {
    try {
        const { projectId, supportUserId } = req.body;

        if (!projectId || !supportUserId) {
            return res.status(400).json({
                success: false,
                message: "Project ID and Support User ID are required",
            });
        }

        // Verify project exists
        const project = await Project.findById(projectId);
        if (!project) {
            return res.status(404).json({
                success: false,
                message: "Project not found",
            });
        }

        // Verify support user exists and is active
        const supportUser = await SupportUser.findById(supportUserId);
        if (!supportUser) {
            return res.status(404).json({
                success: false,
                message: "Support user not found",
            });
        }

        if (!supportUser.isActive) {
            return res.status(400).json({
                success: false,
                message: "Cannot assign inactive support user to project",
            });
        }

        // Check if already assigned
        const existingAssignment = await ProjectSupportUser.findOne({
            projectId,
            supportUserId,
        });

        if (existingAssignment) {
            // If exists but inactive, reactivate it
            if (!existingAssignment.isActive) {
                existingAssignment.isActive = true;
                existingAssignment.assignedByAdminId = req.admin.adminId;
                await existingAssignment.save();

                // Notify support user
                try {
                    const io = req.app.get("io");
                    if (io) {
                        const payload = {
                            projectId: project.projectId,
                            projectName: project.projectName,
                            action: 'assigned'
                        };
                        const token = encryptMessage(JSON.stringify(payload));
                        emitToUser(io, String(supportUserId), "project_assignment_update", { token });
                    }
                } catch (socketErr) {
                    console.error("Error emitting project assignment event:", socketErr);
                }

                return res.status(200).json({
                    success: true,
                    message: "Support user reassigned to project successfully",
                    assignment: existingAssignment,
                });
            }

            return res.status(400).json({
                success: false,
                message: "Support user is already assigned to this project",
            });
        }

        // Create new assignment
        const assignment = await ProjectSupportUser.create({
            projectId,
            supportUserId,
            assignedByAdminId: req.admin.adminId,
        });

        // Notify support user
        try {
            const io = req.app.get("io");
            if (io) {
                const payload = {
                    projectId: project.projectId,
                    projectName: project.projectName,
                    action: 'assigned'
                };
                const token = encryptMessage(JSON.stringify(payload));
                emitToUser(io, String(supportUserId), "project_assignment_update", { token });
            }
        } catch (socketErr) {
            console.error("Error emitting project assignment event:", socketErr);
        }

        return res.status(201).json({
            success: true,
            message: "Support user assigned to project successfully",
            assignment,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server error",
        });
    }
};

// ==============================
// 2) REMOVE Support User from Project (Admin Only)
// ==============================
export const removeSupportUserFromProject = async (req, res) => {
    try {
        const { assignmentId } = req.params;

        if (!assignmentId) {
            return res.status(400).json({
                success: false,
                message: "Assignment ID is required",
            });
        }

        const assignment = await ProjectSupportUser.findById(assignmentId);

        if (!assignment) {
            return res.status(404).json({
                success: false,
                message: "Assignment not found",
            });
        }

        // Soft delete - set isActive to false
        assignment.isActive = false;
        await assignment.save();

        // Notify support user
        try {
            const io = req.app.get("io");
            if (io) {
                const project = await Project.findById(assignment.projectId);
                const payload = {
                    projectId: project?.projectId || String(assignment.projectId),
                    action: 'removed'
                };
                const token = encryptMessage(JSON.stringify(payload));
                emitToUser(io, String(assignment.supportUserId), "project_assignment_update", { token });
            }
        } catch (socketErr) {
            console.error("Error emitting project removal event:", socketErr);
        }

        return res.status(200).json({
            success: true,
            message: "Support user removed from project successfully",
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server error",
        });
    }
};

// ==============================
// 3) GET All Projects for a Support User
// ==============================
export const getProjectsForSupportUser = async (req, res) => {
    try {
        const { supportUserId } = req.params;

        // SECURITY: Ownership check — support users can only view their own projects
        // Admins (req.admin) can view any support user's projects
        if (req.supportUser && req.supportUser.id.toString() !== supportUserId) {
            return res.status(403).json({
                success: false,
                message: "Access denied: you can only view your own project assignments",
            });
        }

        const assignments = await ProjectSupportUser.find({
            supportUserId,
            isActive: true,
        })
            .populate("projectId")
            .populate("assignedByAdminId", "username email")
            .sort({ createdAt: -1 });

        // Filter out assignments where project has been deleted (projectId is null)
        const validAssignments = assignments.filter((assignment) => assignment.projectId !== null);

        // Map and fetch unread counts
        const projects = await Promise.all(validAssignments.map(async (assignment) => {
            const projectData = assignment.projectId;
            let unreadCount = 0;

            if (projectData && projectData.collections?.messages) {
                try {
                    unreadCount = await getPersonalizedUnreadCount(projectData, supportUserId, 'support');
                } catch (err) {
                    console.error(`Error fetching unread count for project ${projectData.projectId}:`, err);
                }
            }

            let logoUrl = projectData?.widgetConfig?.supportLogoUrl || projectData?.widgetConfig?.logoUrl;
            if (logoUrl) {
                // Convert logo to Base64 so it displays immediately without access issues
                logoUrl = await getFileAsBase64(logoUrl);
            }

            return {
                assignmentId: assignment._id,
                project: {
                    _id: projectData?._id,
                    projectId: projectData?.projectId,
                    projectName: projectData?.projectName,
                    websiteUrl: projectData?.websiteUrl,
                    logoUrl: logoUrl,
                    unreadCount: unreadCount
                },
                assignedBy: assignment.assignedByAdminId,
                assignedAt: assignment.createdAt
            };
        }));

        return res.status(200).json({
            success: true,
            projects,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server error",
        });
    }
};

// ==============================
// 4) GET All Support Users for a Project
// ==============================
export const getSupportUsersForProject = async (req, res) => {
    try {
        const { projectId } = req.params;

        // Determine if projectId is an ObjectId or custom string projectId
        let mongoProjectId;
        if (mongoose.Types.ObjectId.isValid(projectId)) {
            // If it looks like an ObjectId, treat it as _id directly
            mongoProjectId = projectId;
        } else {
            // Otherwise, look up the Project by its custom projectId field
            const project = await Project.findOne({ projectId: projectId }).select("_id");
            if (!project) {
                return res.status(404).json({
                    success: false,
                    message: "Project not found",
                });
            }
            mongoProjectId = project._id;
        }

        // Query ProjectSupportUser assignments with the correct MongoDB _id
        const assignments = await ProjectSupportUser.find({
            projectId: mongoProjectId,
            isActive: true,
        })
            .populate("supportUserId", "username email isActive")
            .populate("assignedByAdminId", "username email")
            .sort({ createdAt: -1 });

        // Filter out assignments where supportUser is null (deleted user)
        const validAssignments = assignments.filter(a => a.supportUserId !== null);

        const supportUsers = validAssignments.map((assignment) => ({
            assignmentId: assignment._id,
            supportUser: assignment.supportUserId,
            assignedBy: assignment.assignedByAdminId,
            assignedAt: assignment.createdAt,
        }));

        return res.status(200).json({
            success: true,
            supportUsers,
        });
    } catch (error) {
        console.error("getSupportUsersForProject error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error",
        });
    }
};

// ==============================
// 5) GET All Assignments (Admin Dashboard)
// ==============================
export const getAllAssignments = async (req, res) => {
    try {
        const assignments = await ProjectSupportUser.find({ isActive: true })
            .populate("projectId", "projectName websiteUrl")
            .populate("supportUserId", "username email isActive")
            .populate("assignedByAdminId", "username email")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            assignments,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server error",
        });
    }
};

// ==============================
// 6) GET Pending Transfers for a Support User
// ==============================
export const getPendingTransfersForSupportUser = async (req, res) => {
    try {
        const { supportUserId } = req.params;

        // Guard against undefined or invalid ObjectId being passed
        if (!supportUserId || supportUserId === 'undefined' || !/^[a-f\d]{24}$/i.test(supportUserId)) {
            return res.status(400).json({ success: false, message: "Invalid or missing supportUserId" });
        }

        if (req.supportUser && req.supportUser.id.toString() !== supportUserId) {
            return res.status(403).json({
                success: false,
                message: "Access denied: you can only view your own pending transfers",
            });
        }

        let validProjects = [];

        if (req.admin) {
            // Admins don't have ProjectSupportUser assignments, they can access all projects
            validProjects = await Project.find({});
        } else {
            // Get all active assignments for this support user
            const assignments = await ProjectSupportUser.find({
                supportUserId,
                isActive: true,
            }).populate("projectId");
            validProjects = assignments.map(a => a.projectId).filter(p => p !== null);
        }

        let allPendingTransfers = [];

        for (const projectData of validProjects) {
            if (projectData && projectData.collections?.metadata) {
                try {
                    const MetadataModel = getMetadataModel(projectData.collections.metadata);

                    // Find all metadata documents where pendingTransfer.toIds matches supportUserId
                    const pendingChats = await MetadataModel.find({
                        "pendingTransfer.toIds": supportUserId
                    }).lean();

                    for (const chat of pendingChats) {
                        let assignerName = "Support Agent";
                        if (chat.pendingTransfer.fromId) {
                            try {
                                const assignerUser = await SupportUser.findById(chat.pendingTransfer.fromId).select('username email').lean();
                                if (assignerUser) {
                                    assignerName = assignerUser.username || assignerUser.email || "Support Agent";
                                } else {
                                    const assignerAdmin = await Admin.findById(chat.pendingTransfer.fromId).select('username email').lean();
                                    if (assignerAdmin) {
                                        assignerName = assignerAdmin.username || assignerAdmin.email || "Support Agent";
                                    }
                                }
                            } catch (e) { }
                        }

                        allPendingTransfers.push({
                            chatId: chat.chatId,
                            projectId: projectData.projectId,
                            fromId: chat.pendingTransfer.fromId,
                            fromName: assignerName,
                            timestamp: chat.pendingTransfer.requestedAt ? new Date(chat.pendingTransfer.requestedAt).getTime() : Date.now()
                        });
                    }
                } catch (err) {
                    console.error(`Error fetching pending transfers for config ${projectData.projectId}:`, err);
                }
            }
        }

        // Sort by timestamp descending
        allPendingTransfers.sort((a, b) => b.timestamp - a.timestamp);

        return res.status(200).json({
            success: true,
            pendingTransfers: allPendingTransfers,
        });

    } catch (error) {
        console.error("getPendingTransfersForSupportUser err:", error);
        return res.status(500).json({
            success: false,
            message: "Server error",
        });
    }
};

// ==============================
// 8) GET Assignment Data (Assigned & Available Users) for a Project
// ==============================
export const getAssignmentDataForProject = async (req, res) => {
    try {
        const { projectId } = req.params;

        if (!projectId) {
            return res.status(400).json({ success: false, message: "projectId is required" });
        }

        // Determine if projectId is an ObjectId or custom string projectId
        let mongoProjectId;
        if (mongoose.Types.ObjectId.isValid(projectId)) {
            mongoProjectId = projectId;
        } else {
            const project = await Project.findOne({ projectId: projectId }).select("_id");
            if (!project) {
                return res.status(404).json({ success: false, message: "Project not found" });
            }
            mongoProjectId = project._id;
        }

        // 1. Get all active support users
        const allUsers = await SupportUser.find({ isActive: true }).select("username email isActive").lean();

        // 2. Get active assignments for this project
        const activeAssignments = await ProjectSupportUser.find({
            projectId: mongoProjectId,
            isActive: true
        }).select("supportUserId").lean();

        const assignedUserIds = activeAssignments.map(a => a.supportUserId.toString());

        // 3. Categorize users
        const assigned = [];
        const available = [];

        for (const u of allUsers) {
            const isAssigned = assignedUserIds.includes(u._id.toString());

            if (isAssigned) {
                // Find assignment ID for deletion
                const assignment = activeAssignments.find(a => a.supportUserId.toString() === u._id.toString());
                assigned.push({
                    ...u,
                    assignmentId: assignment._id
                });
            } else {
                available.push(u);
            }
        }

        return res.status(200).json({
            success: true,
            assigned,
            available
        });
    } catch (error) {
        console.error("getAssignmentDataForProject error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==============================
// 7) GET Assignment Data (Assigned & Available) for a Support User
// ==============================
export const getAssignmentDataForSupportUser = async (req, res) => {
    try {
        const { supportUserId } = req.params;

        if (!supportUserId) {
            return res.status(400).json({ success: false, message: "supportUserId is required" });
        }

        // 1. Get all projects
        const allProjects = await Project.find({}).select("projectName websiteUrl projectId widgetConfig").lean();

        // 2. Get active assignments for this support user
        const activeAssignments = await ProjectSupportUser.find({
            supportUserId,
            isActive: true
        }).select("projectId").lean();

        const assignedProjectIds = activeAssignments.map(a => a.projectId.toString());

        // 3. Categorize projects
        const assigned = [];
        const available = [];

        for (const p of allProjects) {
            const isAssigned = assignedProjectIds.includes(p._id.toString());

            // Format project object for frontend
            let logoUrl = p.widgetConfig?.supportLogoUrl || p.widgetConfig?.logoUrl;
            if (logoUrl) {
                logoUrl = await getFileAsBase64(logoUrl);
            }

            const projectObj = {
                _id: p._id,
                projectId: p.projectId,
                projectName: p.projectName,
                websiteUrl: p.websiteUrl,
                logoUrl: logoUrl
            };

            if (isAssigned) {
                // Find assignment ID for deletion
                const assignment = activeAssignments.find(a => a.projectId.toString() === p._id.toString());
                assigned.push({
                    ...projectObj,
                    assignmentId: assignment._id
                });
            } else {
                available.push(projectObj);
            }
        }

        return res.status(200).json({
            success: true,
            assigned,
            available
        });
    } catch (error) {
        console.error("getAssignmentDataForSupportUser error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};
