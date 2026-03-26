import QuickReply from "../model/QuickReply.js";

// Helper to determine the effective user id and field
const getEffectiveUser = (req, paramsId) => {
    // If it's an admin
    if (req.admin && req.admin.adminId) {
        return {
            id: req.admin.adminId,
            field: 'adminId',
            isAdmin: true
        };
    }
    // If it's a support user
    if (req.supportUser && req.supportUser.id) {
        return {
            id: req.supportUser.id,
            field: 'supportUserId',
            isAdmin: false
        };
    }
    return null; // Should not happen with auth middleware
};

// @desc    Get all quick replies (support users see their own + admin's, admins see all admin's)
// @route   GET /api/quick-replies/:userId
export const getQuickReplies = async (req, res) => {
    try {
        const { userId } = req.params;
        const user = getEffectiveUser(req);
        
        if (!user) {
            return res.status(401).json({ message: "Not authorized" });
        }

        // For Support Users, we ensure they are requesting for themselves
        // Admins can request their own replies (which are global)
        if (!user.isAdmin && user.id.toString() !== userId) {
            return res.status(403).json({ message: "Access denied" });
        }

        let query;
        if (user.isAdmin) {
            // Admins see EVERYTHING: Global replies + all support users' private replies
            query = {};
        } else {
            // Support users see all admin-created replies + their own private ones
            query = {
                $or: [
                    { adminId: { $ne: null } },
                    { supportUserId: user.id }
                ]
            };
        }

        const replies = await QuickReply.find(query)
            .populate("supportUserId", "username email")
            .populate("adminId", "username email")
            .sort({ createdAt: -1 });
        res.json(replies);
    } catch (error) {
        console.error("getQuickReplies error:", error);
        res.status(500).json({ message: "Server Error" });
    }
};

// @desc    Create a new quick reply
// @route   POST /api/quick-replies
export const createQuickReply = async (req, res) => {
    try {
        const { title, message } = req.body;
        const user = getEffectiveUser(req);

        if (!user) {
            return res.status(401).json({ message: "Not authorized" });
        }

        if (!title || !message) {
            return res.status(400).json({ message: "Title and message are required" });
        }

        // Check if title already exists
        // For Admins: Check across all admin-created (global) replies
        // For Support Users: Check only their own private replies
        const duplicateQuery = user.isAdmin 
            ? { adminId: { $ne: null }, title } 
            : { supportUserId: user.id, title };

        const existingReply = await QuickReply.findOne(duplicateQuery);
        if (existingReply) {
            return res.status(400).json({ message: `Title "${title}" already exists` });
        }

        const newReply = await QuickReply.create({
            [user.field]: user.id,
            title,
            message,
        });

        // Emit socket event for real-time updates
        const io = req.app.get('io');
        if (io) {
            if (user.isAdmin) {
                io.emit("quick_reply_updated", { type: 'global', action: 'create' });
            } else {
                io.to(`user_${user.id}`).emit("quick_reply_updated", { type: 'private', action: 'create', userId: user.id });
            }
        }

        res.status(201).json(newReply);
    } catch (error) {
        console.error("createQuickReply error:", error);
        res.status(500).json({ message: "Server Error" });
    }
};

// @desc    Update a quick reply
// @route   PUT /api/quick-replies/:id
export const updateQuickReply = async (req, res) => {
    try {
        const { title, message } = req.body;
        const user = getEffectiveUser(req);

        if (!user) {
            return res.status(401).json({ message: "Not authorized" });
        }

        const reply = await QuickReply.findById(req.params.id);

        if (!reply) {
            return res.status(404).json({ message: "Reply not found" });
        }

        // Access Control:
        // 1. Admins can update ANY reply (global or support user private)
        // 2. Support users can only update their own replies
        const isOwner = user.isAdmin || (reply.supportUserId && reply.supportUserId.toString() === user.id.toString());
        
        if (!isOwner) {
            return res.status(403).json({ message: "Access denied: you can only update your own replies" });
        }

        if (title) reply.title = title;
        if (message) reply.message = message;

        await reply.save();

        // Emit socket event for real-time updates
        const io = req.app.get('io');
        if (io) {
            if (user.isAdmin) {
                io.emit("quick_reply_updated", { type: 'global', action: 'update' });
            } else {
                io.to(`user_${user.id}`).emit("quick_reply_updated", { type: 'private', action: 'update', userId: user.id });
            }
        }

        res.json(reply);
    } catch (error) {
        res.status(500).json({ message: "Server Error" });
    }
};

// @desc    Delete a quick reply
// @route   DELETE /api/quick-replies/:id
export const deleteQuickReply = async (req, res) => {
    try {
        const user = getEffectiveUser(req);

        if (!user) {
            return res.status(401).json({ message: "Not authorized" });
        }

        const reply = await QuickReply.findById(req.params.id);

        if (!reply) {
            return res.status(404).json({ message: "Reply not found" });
        }

        // Access Control:
        // 1. Admins can delete ANY reply (global or support user private)
        // 2. Support users can only delete their own replies
        const isOwner = user.isAdmin || (reply.supportUserId && reply.supportUserId.toString() === user.id.toString());

        if (!isOwner) {
            return res.status(403).json({ message: "Access denied: you can only delete your own replies" });
        }

        await reply.deleteOne();

        // Emit socket event for real-time updates
        const io = req.app.get('io');
        if (io) {
            if (user.isAdmin) {
                io.emit("quick_reply_updated", { type: 'global', action: 'delete' });
            } else {
                io.to(`user_${user.id}`).emit("quick_reply_updated", { type: 'private', action: 'delete', userId: user.id });
            }
        }

        res.json({ message: "Quick reply removed" });
    } catch (error) {
        res.status(500).json({ message: "Server Error" });
    }
};
