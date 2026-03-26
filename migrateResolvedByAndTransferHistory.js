/**
 * MIGRATION: Convert resolvedBy (object → array) and transferHistory (flat array → array-of-arrays)
 *
 * Run once:  node migrateResolvedByAndTransferHistory.js
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) {
    console.error("❌  MONGO_URI not set in .env");
    process.exit(1);
}

await mongoose.connect(MONGO_URI);

// ──────────────────────────────────────────────────────────────────────────────
// Helper: collect every metadata collection name from the projects collection
// ──────────────────────────────────────────────────────────────────────────────
const db = mongoose.connection.db;

const projects = await db.collection("projects").find({}, { projection: { "collections.metadata": 1 } }).toArray();
const metadataCollections = [...new Set(
    projects
        .map(p => p?.collections?.metadata)
        .filter(Boolean)
)];


let totalFixed = 0;

for (const collName of metadataCollections) {
    const coll = db.collection(collName);

    // ── 1. Fix resolvedBy: object → array ────────────────────────────────────
    // Find docs where resolvedBy exists but is NOT an array (i.e. old object shape)
    const docsToFix = await coll.find({
        resolvedBy: { $exists: true, $not: { $type: "array" } }
    }).toArray();


    for (const doc of docsToFix) {
        const old = doc.resolvedBy;

        // Build the new array — if old object had a real userId, keep it; otherwise empty
        let newResolvedBy = [];
        if (old && old.userId) {
            newResolvedBy = [{
                userId: old.userId || null,
                username: old.username || null,
                chatId: doc.chatId || null,
                resolvedAt: old.resolvedAt || new Date(),
            }];
        }

        await coll.updateOne(
            { _id: doc._id },
            { $set: { resolvedBy: newResolvedBy } }
        );
        totalFixed++;
    }

    // ── 2. Fix transferHistory: flat array → array-of-arrays ─────────────────
    // Detect docs where transferHistory is an array but its first element is an object
    // (i.e. flat — old shape) rather than an array (new session shape).
    const transferDocs = await coll.find({
        transferHistory: { $exists: true, $type: "array", $ne: [] }
    }).toArray();

    let transferFixed = 0;
    for (const doc of transferDocs) {
        const th = doc.transferHistory;
        if (!Array.isArray(th) || th.length === 0) continue;

        // If first element is an object (not an array), it's the old flat format
        if (!Array.isArray(th[0])) {
            // Wrap the whole flat array into a single session inner-array
            const wrapped = [th.map(entry => ({
                chatId: entry.chatId || doc.chatId || null,
                fromId: entry.fromId || null,
                toId: entry.toId || null,
                transferredAt: entry.transferredAt || new Date(),
            }))];

            await coll.updateOne(
                { _id: doc._id },
                { $set: { transferHistory: wrapped } }
            );
            transferFixed++;
            totalFixed++;
        }
    }

    // Also ensure every doc has at least [[]] so new pushes work
    await coll.updateMany(
        { $or: [{ transferHistory: { $exists: false } }, { transferHistory: [] }] },
        { $set: { transferHistory: [[]] } }
    );


}

await mongoose.disconnect();
process.exit(0);