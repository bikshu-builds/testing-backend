import Project from "../model/project.js";
import { getMetadataModel } from "../model/dynamic/metadataModel.js";
import { getMessageModel } from "../model/dynamic/messageModel.js";
import { encryptMessageCBC as encryptMessage } from "./messageEncryption.js";

// Exact Resolution Helper (Can be called by timers OR the background scanner)
export const resolveChat = async (io, pId, chatId, reason = "Auto-Resolve") => {
    try {
        const project = await Project.findOne({ projectId: pId }).lean();
        if (!project || !project.collections?.metadata) return false;

        const MetadataModel = getMetadataModel(project.collections.metadata);
        const MessageModel = getMessageModel(project.collections.messages);

        const chat = await MetadataModel.findOne({ chatId }).lean();
        if (!chat || chat.status === 'resolved') return false;

        const resolvedTime = new Date();
        const resolveRecord = {
            userId: "system",
            username: reason,
            chatId: chatId,
            resolvedAt: resolvedTime,
            // If it's not a manual resolve by a human agent, it's an auto-resolve
            durationString: reason === "Manual" ? "Manual" : "2m",
        };

        const update = {
            $set: {
                status: "resolved",
                assignedTo: null,
                lastMessageDetails: {
                    timestamp: resolvedTime,
                    senderType: 'system',
                    message: 'Resolved conversation'
                },
                pendingRatingCount: 0,
                ratingRequested: false,
                reviewRequested: false
            },
            $push: { 
                resolvedBy: resolveRecord 
            }
        };

        if (chat.helpCycles?.length > 0) {
            const lastIx = chat.helpCycles.length - 1;
            update.$set[`helpCycles.${lastIx}.resolvedAt`] = resolvedTime;
            update.$set[`helpCycles.${lastIx}.resolvedBy`] = reason;
        }

        await MetadataModel.findOneAndUpdate({ chatId }, update);

        // System message for the UI Pill
        const sysMsg = new MessageModel({
            projectId: pId,
            chatId: chatId,
            senderId: "system",
            senderType: "system",
            message: "Resolved conversation",
            createdAt: resolvedTime,
            status: "seen"
        });
        await sysMsg.save();

        // SOCKET BCAST
        if (io) {
            const statusPayload = {
                chatId: chatId,
                projectId: pId,
                status: 'resolved',
                lastMessage: sysMsg.toObject(),
                unreadCount: 0,
                autoResolved: true,
                resolvedBy: resolveRecord
            };
            const statusToken = encryptMessage(JSON.stringify(statusPayload));
            const msgToken = encryptMessage(JSON.stringify(sysMsg.toObject()));
            
            io.to(`project_${pId}`).emit("chat_status_changed", { token: statusToken });
            io.to(`${pId}_${chatId}`).emit("chat_status_changed", { token: statusToken });
            io.to(`${pId}_${chatId}`).emit("new_message", { token: msgToken });

            const forceToken = encryptMessage(JSON.stringify({ action: 'clear_session', chatId, status: 'resolved' }));
            io.to(`${pId}_${chatId}`).emit("chat_force_logout", { token: forceToken });
        }

        return true;
    } catch (err) {
        console.error(`[Auto-Resolve] Error resolving chat ${chatId}:`, err.message);
        return false;
    }
};

// 2-minute fallback for chats already in the queue when server starts
const AUTO_RESOLVE_MINUTES = 2;

export const startAutoResolveCron = (io) => {

    setInterval(async () => {
        try {
            const projects = await Project.find({}).lean();
            for (const project of projects) {
                const pId = project.projectId;
                if (!project.collections?.metadata) continue;

                const MetadataModel = getMetadataModel(project.collections.metadata);
                const MessageModel = getMessageModel(project.collections.messages);

                const inactiveChats = await MetadataModel.find({
                    projectId: pId,
                    status: { $ne: "resolved" }
                }).lean();

                for (const chat of inactiveChats) {
                    try {
                        const lastMsg = await MessageModel.findOne({
                            chatId: chat.chatId,
                            isDeleted: false
                        }).sort({ createdAt: -1 }).lean();

                        if (!lastMsg) continue;

                        const lastActivity = new Date(lastMsg.createdAt);
                        const minsInactive = (Date.now() - lastActivity.getTime()) / 60000;
                        const senderTypeLower = String(lastMsg.senderType || '').toLowerCase();
                        const isEligible = ['support', 'admin', 'bot', 'assistant', 'system'].includes(senderTypeLower);

                        if (isEligible && minsInactive >= AUTO_RESOLVE_MINUTES) {
                            await resolveChat(io, pId, chat.chatId, "Inactivity Scanner");
                        }
                    } catch (e1) { /* Skip single chat errors */ }
                }
            }
        } catch (e3) { /* Skip global loop errors */ }
    }, 60000);
};
