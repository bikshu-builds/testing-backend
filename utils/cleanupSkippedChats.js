import { getMetadataModel } from "../model/dynamic/metadataModel.js";
import { getMessageModel } from "../model/dynamic/messageModel.js";
import Project from "../model/project.js";

/**
 * Cleanup function to delete chats where email was skipped
 * based on project's deleteSkippedAfterDays setting
 */
export const cleanupSkippedEmailChats = async () => {
    try {

        // Get all projects
        const projects = await Project.find({
            "emailSetting.collectEmails": true,
            "emailSetting.deleteSkippedAfterDays": { $gt: 0 }
        });

        let totalDeleted = 0;

        for (const project of projects) {
            const deleteAfterDays = project.emailSetting.deleteSkippedAfterDays || 3;
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - deleteAfterDays);

            try {
                const MetadataModel = getMetadataModel(project.collections.metadata);
                const MessageModel = getMessageModel(project.collections.messages);

                // Find all metadata records where email was skipped and older than cutoff
                const skippedChats = await MetadataModel.find({
                    projectId: project.projectId,
                    emailSkipped: true,
                    createdAt: { $lt: cutoffDate }
                });

                if (skippedChats.length > 0) {
                    const chatIds = skippedChats.map(chat => chat.chatId);

                    // Delete messages for these chats
                    const messagesDeleted = await MessageModel.deleteMany({
                        chatId: { $in: chatIds }
                    });

                    // Delete metadata for these chats
                    const metadataDeleted = await MetadataModel.deleteMany({
                        chatId: { $in: chatIds }
                    });

                    totalDeleted += chatIds.length;

                }
            } catch (err) {
                console.error(`Error cleaning up project ${project.projectId}:`, err);
            }
        }
        return { success: true, totalDeleted };

    } catch (error) {
        console.error("❌ Error in cleanup job:", error);
        return { success: false, error: error.message };
    }
};

/**
 * Schedule cleanup to run daily at 2 AM
 */
export const scheduleCleanup = () => {
    // Run cleanup every 24 hours
    const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    // Run initial cleanup after 1 minute
    setTimeout(() => {
        cleanupSkippedEmailChats();

        // Then run every 24 hours
        setInterval(cleanupSkippedEmailChats, CLEANUP_INTERVAL);
    }, 60 * 1000); // Start after 1 minute


};
