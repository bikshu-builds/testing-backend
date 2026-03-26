import mongoose from 'mongoose';
import dotenv from 'dotenv';
import ProjectSupportUser from './model/ProjectSupportUser.js';
import Project from './model/project.js';
import SupportUser from './model/supportUser.js';
import { getPersonalizedUnreadCount, getChatUnreadCount } from './utils/unreadCounts.js';

dotenv.config();

async function check() {
    await mongoose.connect(process.env.MONGO_URI);

    // Find a support user
    const supportUsers = await SupportUser.find();
    if (!supportUsers.length) {
        process.exit(1);
    }

    const testUser = supportUsers[0];

    const assignments = await ProjectSupportUser.find({ supportUserId: testUser._id, isActive: true }).populate('projectId');

    for (const assignment of assignments) {
        const project = assignment.projectId;
        if (!project) continue;


        const count = await getPersonalizedUnreadCount(project, testUser._id, 'support');

        // check individualized chats
        const metaName = project.collections.metadata;
        const msgName = project.collections.messages;
        const MetaModel = mongoose.models[metaName] || mongoose.connection.model(metaName, new mongoose.Schema({}, { strict: false }));
        const MsgModel = mongoose.models[msgName] || mongoose.connection.model(msgName, new mongoose.Schema({}, { strict: false }));

        const metas = await MetaModel.find();
        let manualSum = 0;
        for (const meta of metas) {
            const chatUnread = await getChatUnreadCount(project, meta.chatId, testUser._id, 'support');
            manualSum += chatUnread;

            // if chatUnread is 0, let's see why
            const uidStr = testUser._id.toString();
            const q = { chatId: meta.chatId, senderType: 'student', status: { $ne: 'seen' }, isDeleted: false };
            const mCount = await MsgModel.countDocuments(q);
        }
    }

    mongoose.disconnect();
}

check().catch(console.error);
