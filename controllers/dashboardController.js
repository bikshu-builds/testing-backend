import Project from "../model/project.js";
import { getMetadataModel } from "../model/dynamic/metadataModel.js";

/**
 * GET /api/dashboard/stats
 * Query params:
 *   filter: "today" | "yesterday" | "date" | "range"  (default: "today")
 *   date:   ISO date string (used when filter === "date")
 *   from:   ISO date string (used when filter === "range")
 *   to:     ISO date string (used when filter === "range")
 */
export const getDashboardStats = async (req, res) => {
    try {
        const { filter = "today", date, from, to } = req.query;

        // ── Build date window ──────────────────────────────────────────────
        const now = new Date();

        // Helper: start of a day (midnight UTC)
        const startOfDay = (d) => {
            const s = new Date(d);
            s.setUTCHours(0, 0, 0, 0);
            return s;
        };

        // Helper: exclusive end of a day (next midnight)
        const endOfDay = (d) => {
            const e = new Date(d);
            e.setUTCHours(23, 59, 59, 999);
            return e;
        };

        let rangeStart, rangeEnd;

        switch (filter) {
            case "all": {
                // Return all data from the beginning of time up to now
                rangeStart = new Date("2000-01-01");
                rangeEnd = endOfDay(now);
                break;
            }
            case "yesterday": {
                const yesterday = new Date(now);
                yesterday.setUTCDate(now.getUTCDate() - 1);
                rangeStart = startOfDay(yesterday);
                rangeEnd = endOfDay(yesterday);
                break;
            }
            case "date": {
                if (!date) {
                    return res.status(400).json({ success: false, message: "Query param 'date' is required for filter=date" });
                }
                const d = new Date(date);
                rangeStart = startOfDay(d);
                rangeEnd = endOfDay(d);
                break;
            }
            case "range": {
                if (!from || !to) {
                    return res.status(400).json({ success: false, message: "Query params 'from' and 'to' are required for filter=range" });
                }
                rangeStart = startOfDay(new Date(from));
                rangeEnd = endOfDay(new Date(to));
                break;
            }
            case "today":
            default: {
                rangeStart = startOfDay(now);
                rangeEnd = endOfDay(now);
                break;
            }
        }

        const dateQuery = { createdAt: { $gte: rangeStart, $lte: rangeEnd } };

        // ── Load all projects ──────────────────────────────────────────────
        const projects = await Project.find().select("projectId projectName collections").lean();

        if (!projects.length) {
            return res.status(200).json({
                success: true,
                filter,
                dateRange: { from: rangeStart, to: rangeEnd },
                overall: { total: 0, totalUsers: 0, resolved: 0, pending: 0, unresolved: 0, unassigned: 0, needsAssist: 0 },
                products: []
            });
        }

        // ── Query each project's metadata collection ───────────────────────
        const productStats = await Promise.all(
            projects.map(async (project) => {
                const collectionName = project.collections?.metadata;
                if (!collectionName) {
                    return {
                        projectId: project.projectId,
                        projectName: project.projectName,
                        total: 0,
                        totalUsers: 0,
                        resolved: 0,
                        pending: 0,
                        unresolved: 0,
                        unassigned: 0,
                        needsAssist: 0,
                    };
                }

                try {
                    const MetadataModel = getMetadataModel(collectionName);

                    const [pendingCount, unresolved, unassigned, needsAssist] = await Promise.all([
                        MetadataModel.countDocuments({ ...dateQuery, status: { $ne: "resolved" } }),
                        MetadataModel.countDocuments({ ...dateQuery, status: "unresolved" }),
                        MetadataModel.countDocuments({ ...dateQuery, assignedTo: null }),
                        MetadataModel.countDocuments({ ...dateQuery, "assistants.0": { $exists: true } }),
                    ]);

                    // Total = (Currently Unresolved created in period) + (Total resolutions that happened in period)
                    const resolvedAgg = await MetadataModel.aggregate([
                        { $unwind: "$resolvedBy" },
                        {
                            $match: {
                                "resolvedBy.resolvedAt": dateQuery.createdAt
                            }
                        },
                        { $count: "count" }
                    ]);
                    const resolved = resolvedAgg[0]?.count || 0;
                    const total = pendingCount + resolved;

                    // ADDED: Calculate Total Unique Chat Users
                    const uniqueUsersArr = await MetadataModel.distinct("userId", dateQuery);
                    const totalUsers = uniqueUsersArr.length;

                    return {
                        projectId: project.projectId,
                        projectName: project.projectName,
                        total,
                        totalUsers, // added for chat users counting
                        resolved,
                        pending: pendingCount,
                        unresolved,
                        unassigned,
                        needsAssist,
                    };
                } catch (err) {
                    console.error(`Error querying metadata for project ${project.projectId}:`, err.message);
                    return {
                        projectId: project.projectId,
                        projectName: project.projectName,
                        total: 0,
                        resolved: 0,
                        pending: 0,
                        unresolved: 0,
                        unassigned: 0,
                        needsAssist: 0,
                    };
                }
            })
        );

        // ── Compute overall totals ─────────────────────────────────────────
        const overall = productStats.reduce(
            (acc, p) => ({
                total: acc.total + p.total,
                totalUsers: acc.totalUsers + (p.totalUsers || 0),
                resolved: acc.resolved + p.resolved,
                pending: acc.pending + p.pending,
                unresolved: acc.unresolved + p.unresolved,
                unassigned: acc.unassigned + p.unassigned,
                needsAssist: acc.needsAssist + p.needsAssist,
            }),
            { total: 0, totalUsers: 0, resolved: 0, pending: 0, unresolved: 0, unassigned: 0, needsAssist: 0 }
        );

        return res.status(200).json({
            success: true,
            filter,
            dateRange: { from: rangeStart, to: rangeEnd },
            overall,
            products: productStats,
        });

    } catch (error) {
        console.error("getDashboardStats error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while fetching dashboard stats",
            error: error.message,
        });
    }
};
