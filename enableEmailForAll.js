// Script to enable email collection for ALL existing projects
import mongoose from 'mongoose';
import Project from './model/project.js';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGO_URI;

async function enableEmailForAllProjects() {
    try {
        await mongoose.connect(MONGODB_URI);

        const result = await Project.updateMany(
            {
                $or: [
                    { 'emailSetting.collectEmails': { $exists: false } },
                    { 'emailSetting.collectEmails': false }
                ]
            },
            {
                $set: {
                    'emailSetting.collectEmails': true,
                    'emailSetting.isEmailMandatory': true,
                    'emailSetting.emailMessage': 'Please enter your email to start chatting with our support team',
                    'emailSetting.deleteSkippedAfterDays': 7
                }
            }
        );


        // List all projects with their email settings
        const projects = await Project.find().select('projectId projectName emailSetting');
        projects.forEach(p => {
        });

        await mongoose.disconnect();
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

enableEmailForAllProjects();
