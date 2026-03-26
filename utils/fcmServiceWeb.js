import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use separate service account for Web to avoid conflicts with App
const serviceAccountPath = path.join(__dirname, "..", "service-account-web.json");

let webApp;
try {
    if (fs.existsSync(serviceAccountPath)) {
        const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf-8"));
        webApp = admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        }, "chattie-web"); // Named instance to avoid conflict with default app
        console.log("Firebase Web Admin Initialized ✅");
    } else {
        console.warn("service-account-web.json not found. Web notifications disabled.");
    }
} catch (error) {
    console.error("Error initializing Firebase Web Admin:", error);
}

/**
 * Sends a web push notification to a specific user's registered FCM tokens.
 * @param {string} userId - The ID of the support user.
 * @param {object} payload - The notification payload (title, body, chatId, etc.).
 */
export const sendWebNotification = async (userId, payload) => {
    if (!webApp) return;

    try {
        const WebNotificationToken = (await import("../model/WebNotificationToken.js")).default;
        const tokensDoc = await WebNotificationToken.find({ userId, isActive: true }).select("fcmToken").lean();

        if (!tokensDoc || tokensDoc.length === 0) {
            return;
        }

        const tokens = tokensDoc.map(t => t.fcmToken);

        const message = {
            data: {
                title: payload.title,
                body: payload.body,
                type: payload.type || "new_message",
                chatId: String(payload.chatId),
                projectId: String(payload.projectId),
                click_action: `/supportUser/inbox/${String(payload.projectId)}?chat=${String(payload.chatId)}`,
            },
            tokens: tokens,
        };

        const response = await webApp.messaging().sendEachForMulticast(message);
        console.log(`Successfully sent ${response.successCount} web notifications; ${response.failureCount} failed.`);
        
        // Clean up invalid tokens if needed
        if (response.failureCount > 0) {
            const failedTokens = [];
            response.responses.forEach((res, idx) => {
                if (!res.success) {
                    failedTokens.push(tokens[idx]);
                }
            });
            if (failedTokens.length > 0) {
                await WebNotificationToken.deleteMany({ fcmToken: { $in: failedTokens } });
            }
        }
    } catch (error) {
        console.error("Error sending web notification:", error);
    }
};
