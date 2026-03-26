import mongoose from "mongoose";

const quickReplySchema = new mongoose.Schema(
    {
        supportUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "SupportUser",
            required: false,
            index: true,
        },
        adminId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Admin",
            required: false,
            index: true,
        },
        title: {
            type: String,
            required: true,
            trim: true,
        },
        message: {
            type: String,
            required: true,
        },
    },
    { timestamps: true }
);

// Ensure a user cannot have duplicate titles for their own quick replies
quickReplySchema.index({ supportUserId: 1, title: 1 }, { unique: true, partialFilterExpression: { supportUserId: { $exists: true, $type: "objectId" } } });
// Global uniqueness for admin-created quick replies
quickReplySchema.index({ title: 1 }, { unique: true, partialFilterExpression: { adminId: { $exists: true } } });

const QuickReply = mongoose.model("QuickReply", quickReplySchema);

export default QuickReply;
