import { getMessageModel } from "../model/dynamic/messageModel.js";
import Project from "../model/project.js";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import s3Client from "../config/s3.js";

/**
 * Cleanup function to delete file/image attachments older than 7 days
 */
export const cleanupOldFiles = async () => {
    try {


        // Get all projects
        const projects = await Project.find({});

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 7); // 7 days ago

        let totalFilesDeleted = 0;

        for (const project of projects) {
            if (!project.collections?.messages) continue;

            try {
                const MessageModel = getMessageModel(project.collections.messages);

                // Find messages with file/image attachments older than 7 days
                // Only process messages that still have a fileUrl
                const oldMediaMessages = await MessageModel.find({
                    projectId: project.projectId,
                    $or: [
                        { messageType: "image" },
                        { messageType: "file" }
                    ],
                    fileUrl: { $ne: null },
                    createdAt: { $lt: cutoffDate }
                });

                if (oldMediaMessages.length > 0) {
                    let projectDeletedCount = 0;

                    for (const msg of oldMediaMessages) {
                        if (!msg.fileUrl) continue;

                        // Extract S3 Key from URL
                        // Format: https://BUCKET.s3.REGION.amazonaws.com/KEY
                        // We need to handle potential signed URLs too (though stored URL usually isn't signed)
                        // Assuming stored URL is the public/base URL

                        let key = null;
                        if (msg.fileUrl.includes('.amazonaws.com/')) {
                            const parts = msg.fileUrl.split('.amazonaws.com/');
                            if (parts.length > 1) {
                                key = parts[1];
                            }
                        }

                        if (key) {
                            try {
                                // Delete from S3
                                await s3Client.send(new DeleteObjectCommand({
                                    Bucket: process.env.AWS_S3_BUCKET,
                                    Key: key
                                }));

                                // Prepare update data
                                const updateData = {
                                    fileUrl: null,
                                    fileName: null,
                                    messageType: "text"
                                };

                                // Only override text if message is effectively empty (no caption)
                                // If there IS a caption, we keep it as is.
                                if (!msg.message || msg.message.trim() === "") {
                                    updateData.message = "File/Image expired";
                                }

                                // Update message to remove file link but keep message record
                                await MessageModel.findByIdAndUpdate(msg._id, updateData);

                                projectDeletedCount++;
                            } catch (s3Error) {
                                console.error(`Failed to delete S3 object ${key}:`, s3Error);
                            }
                        }
                    }

                    totalFilesDeleted += projectDeletedCount;
                    if (projectDeletedCount > 0) {
                    }
                }
            } catch (err) {
                console.error(`Error cleaning up files for project ${project.projectId}:`, err);
            }
        }

        return { success: true, totalDeleted: totalFilesDeleted };

    } catch (error) {
        console.error("❌ Error in file cleanup job:", error);
        return { success: false, error: error.message };
    }
};

/**
 * Schedule cleanup to run periodically
 */
export const scheduleFileCleanup = () => {
    // Run cleanup every 24 hours
    const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

    // Run initial cleanup after 2 minutes (to not block server start)
    setTimeout(() => {
        cleanupOldFiles();

        // Then run every 24 hours
        setInterval(cleanupOldFiles, CLEANUP_INTERVAL);
    }, 2 * 60 * 1000);
};
