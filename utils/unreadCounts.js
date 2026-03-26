import { getMessageModel } from "../model/dynamic/messageModel.js";
import { getMetadataModel } from "../model/dynamic/metadataModel.js";

/**
 * HELPER: Get unread count for a specific chat for a specific user.
 */
export async function getChatUnreadCount(project, chatId, userId, role) {
    try {
        const MessageModel = getMessageModel(project.collections.messages);
        const MetadataModel = getMetadataModel(project.collections.metadata);
        const meta = await MetadataModel.findOne({ chatId }).lean();
        if (!meta || meta.isDeleted || meta.status === 'resolved') return 0;

        // Check if assigned to someone else
        const assignedToId = meta?.assignedTo ? String(meta.assignedTo) : null;
        const originalId = (meta?.originalAssignedTo && !['system', 'bot'].includes(String(meta.originalAssignedTo)))
            ? String(meta.originalAssignedTo)
            : null;
        const effectiveOwnerId = assignedToId ?? originalId;

        if (userId) {
            const uidStr = String(userId);
            if (role === 'admin') {
                // Admins see everything (they requested visibility into all project activity)
                // Note: We used to return 0 if assigned elsewhere, but users now want visibility.
            } else {
                if (effectiveOwnerId && effectiveOwnerId !== uidStr) return 0;
            }

            // Check per-user dismissal.
            // Even if this user is in notificationsSeenBy (they opened the chat before),
            // we must still show the badge if a NEW student message arrived AFTER their
            // last-seen timestamp — i.e., lastStudentMessageAt > userLastSeenAt[userId].
            if (meta?.notificationsSeenBy && meta.notificationsSeenBy.includes(uidStr)) {
                const userLastSeen = meta?.userLastSeenAt instanceof Map
                    ? meta.userLastSeenAt.get(uidStr)
                    : meta?.userLastSeenAt?.[uidStr];
                const hasNewMsgAfterSeen = meta?.lastStudentMessageAt && userLastSeen
                    ? new Date(meta.lastStudentMessageAt) > new Date(userLastSeen)
                    : false;
                if (!hasNewMsgAfterSeen) return 0;
                // Fall through: there IS a new message after their last-seen timestamp
            }
        }

        // PER-USER UNREAD COUNT: Count student messages after user's last seen time.
        // If no userId is provided (e.g. system check), default to counting all unread.
        let lastSeen = null;
        if (userId) {
            const uidStr = String(userId);
            lastSeen = meta?.userLastSeenAt instanceof Map
                ? meta.userLastSeenAt.get(uidStr)
                : meta?.userLastSeenAt?.[uidStr];
        }

        const unreadQuery = {
            chatId,
            senderType: 'student',
            status: { $ne: 'seen' },
            isDeleted: false
        };

        if (lastSeen) {
            unreadQuery.createdAt = { $gt: new Date(lastSeen) };
        }

        return await MessageModel.countDocuments(unreadQuery);
    } catch (err) {
        console.error("getChatUnreadCount error:", err);
        return 0;
    }
}

/**
 * HELPER: Get personalized total unread count for a user in a project.
 * For support users: count student messages in unassigned chats OR chats assigned to them.
 * For admins: count only student messages in unassigned chats (as per user request).
 */
export async function getPersonalizedUnreadCount(project, userId, role) {
    try {
        const MessageModel = getMessageModel(project.collections.messages);
        const MetadataModel = getMetadataModel(project.collections.metadata);

        // 1. Get IDs of chats that are NOT "owned" by this user or are unassigned
        // We need to look up metadata to find assignment statuses.
        // Filter out soft-deleted chats by adding { isDeleted: { $ne: true } }
        const allMetadata = await MetadataModel.find({
            projectId: project.projectId,
            isDeleted: { $ne: true },
            status: { $ne: 'resolved' }
        }).lean();

        const myChatIds = allMetadata.filter(meta => {
            if (meta.isDeleted) return false;
            const assignedToId = meta.assignedTo ? String(meta.assignedTo) : null;
            const originalId = (meta.originalAssignedTo && !['system', 'bot'].includes(String(meta.originalAssignedTo)))
                ? String(meta.originalAssignedTo)
                : null;
            const effectiveOwnerId = assignedToId ?? originalId;

            if (role === 'admin') {
                // Admins count ALL chats in the project
            } else {
                // Support users count UNASSIGNED + THEIR OWN
                if (effectiveOwnerId && effectiveOwnerId !== String(userId)) return false;
            }

            // PER-USER DISMISSAL: Even if the chat is technically "unread" in the DB,
            // if this user has already dismissed the notification, skip it —
            // UNLESS a new student message arrived after their last-seen timestamp.
            if (userId && meta.notificationsSeenBy && meta.notificationsSeenBy.includes(String(userId))) {
                const uidCheck = String(userId);
                const userLastSeen = meta.userLastSeenAt instanceof Map
                    ? meta.userLastSeenAt.get(uidCheck)
                    : meta.userLastSeenAt?.[uidCheck];
                const hasNew = meta?.lastStudentMessageAt && userLastSeen
                    ? new Date(meta.lastStudentMessageAt) > new Date(userLastSeen)
                    : false;
                if (!hasNew) return false;
                // Fall through: new message arrived after their last-seen — keep the chat.
            }

            return true;
        }).map(meta => meta.chatId);

        // 2. Count messages for those chats, respecting each chat's specific per-user lastSeen
        let totalCount = 0;
        const uidStr = userId ? String(userId) : null;

        for (const meta of allMetadata.filter(m => myChatIds.includes(m.chatId))) {
            // Skip if already explicitly dismissed — but only if no NEW message arrived
            // after their last-seen timestamp (same guard as above).
            if (uidStr && meta.notificationsSeenBy && meta.notificationsSeenBy.includes(uidStr)) {
                const userLastSeen = meta.userLastSeenAt instanceof Map
                    ? meta.userLastSeenAt.get(uidStr)
                    : meta.userLastSeenAt?.[uidStr];
                const hasNew = meta?.lastStudentMessageAt && userLastSeen
                    ? new Date(meta.lastStudentMessageAt) > new Date(userLastSeen)
                    : false;
                if (!hasNew) continue;
                // Fall through: there is a new message after their last-seen.
            }

            let lastSeen = null;
            if (uidStr) {
                lastSeen = meta.userLastSeenAt instanceof Map
                    ? meta.userLastSeenAt.get(uidStr)
                    : meta.userLastSeenAt?.[uidStr];
            }

            const msgQuery = {
                chatId: meta.chatId,
                senderType: 'student',
                status: { $ne: 'seen' },
                isDeleted: false
            };

            if (lastSeen) {
                msgQuery.createdAt = { $gt: new Date(lastSeen) };
            }

            const chatCount = await MessageModel.countDocuments(msgQuery);
            totalCount += chatCount;
        }

        return totalCount;
    } catch (err) {
        console.error("getPersonalizedUnreadCount error:", err);
        return 0;
    }
}
