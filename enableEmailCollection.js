// Script to enable email collection for a project
import mongoose from 'mongoose';
import Project from './model/project.js';

const MONGODB_URI = process.env.MONGO_URI;

async function enableEmailCollection() {
    try {
        await mongoose.connect(MONGODB_URI);

        const projectId = '941280342761';

        const result = await Project.findOneAndUpdate(
            { projectId },
            {
                $set: {
                    emailSetting: {
                        collectEmails: true,
                        isEmailMandatory: true,
                        emailMessage: 'Please enter your email to start chatting with our support team',
                        deleteSkippedAfterDays: 7
                    }
                }
            },
            { new: true }
        );

        if (result) {

        } else {
        }

        await mongoose.disconnect();
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

enableEmailCollection();
