import mongoose from "mongoose";

const projectSupportUserSchema = new mongoose.Schema(
    {
        projectId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Project",
            required: true,
        },

        supportUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "SupportUser",
            required: true,
        },

        assignedByAdminId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Admin",
            required: true,
        },

        isActive: {
            type: Boolean,
            default: true,
        },
    },
    { timestamps: true }
);

// prevent duplicates
projectSupportUserSchema.index(
    { projectId: 1, supportUserId: 1 },
    { unique: true }
);

export default mongoose.model("ProjectSupportUser", projectSupportUserSchema);
