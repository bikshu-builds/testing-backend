import admin from 'firebase-admin';

// Initialize Firebase Admin with service accounts
let appAdmin;
let webAdmin;

try {
    const fs = await import('fs');
    const path = await import('path');

    // 1. Initialize Default App (usually for Mobile)
    const appPath = path.join(process.cwd(), 'service-account.json');
    if (fs.existsSync(appPath)) {
        const appSA = JSON.parse(fs.readFileSync(appPath, 'utf8'));
        appAdmin = admin.initializeApp({
            credential: admin.credential.cert(appSA)
        }, 'app'); // Named 'app' to avoid conflict if both exist
    }

    // 2. Initialize Web App (specifically for Browser/Web Push)
    const webPath = path.join(process.cwd(), 'service-account-web.json');
    if (fs.existsSync(webPath)) {
        const webSA = JSON.parse(fs.readFileSync(webPath, 'utf8'));
        webAdmin = admin.initializeApp({
            credential: admin.credential.cert(webSA)
        }, 'web');
    }

    // Fallback/Default behavior for existing deployments
    if (!appAdmin && !webAdmin) {
        if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
            const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
            appAdmin = admin.initializeApp({ credential: admin.credential.cert(sa) });
        } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
            const sa = {
                type: "service_account",
                project_id: process.env.FIREBASE_PROJECT_ID,
                private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                client_email: process.env.FIREBASE_CLIENT_EMAIL,
                client_id: process.env.FIREBASE_CLIENT_ID,
                auth_uri: process.env.FIREBASE_AUTH_URI || "https://accounts.google.com/o/oauth2/auth",
                token_uri: process.env.FIREBASE_TOKEN_URI || "https://oauth2.googleapis.com/token",
                auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL || "https://www.googleapis.com/v1/certs",
                client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
            };
            appAdmin = admin.initializeApp({ credential: admin.credential.cert(sa) });
        }
    }

    if (!appAdmin && !webAdmin) {
        console.warn('Firebase credentials not found. Push notifications will be disabled.');
    }
} catch (error) {
    console.error('Error initializing Firebase Admin:', error);
}

// In-memory cache for FCM tokens (also persist to DB)
const fcmTokenCache = new Map(); // userId -> Set of tokens

/**
 * Register FCM token for a user (Support or Admin)
 */
export const registerFCMToken = async (userId, token, platform = 'android', appVersion) => {
    try {
        if (!fcmTokenCache.has(userId)) {
            fcmTokenCache.set(userId, new Set());
        }
        fcmTokenCache.get(userId).add(token);

        // Try SupportUser first
        const SupportUser = (await import('../model/supportUser.js')).default;
        let user = await SupportUser.findByIdAndUpdate(userId, {
            $addToSet: { fcmTokens: token },
            $set: {
                'deviceInfo.platform': platform,
                'deviceInfo.appVersion': appVersion,
                'deviceInfo.lastSeen': new Date()
            }
        });

        // If not found in SupportUser, try Admin
        if (!user) {
            const Admin = (await import('../model/Admin.js')).default;
            await Admin.findByIdAndUpdate(userId, {
                $addToSet: { fcmTokens: token },
                $set: {
                    'deviceInfo.platform': platform,
                    'deviceInfo.appVersion': appVersion,
                    'deviceInfo.lastSeen': new Date()
                }
            });
        }

        console.log(`[FCM] Registered token for user ${userId} on platform ${platform}`);
    } catch (error) {
        console.error('Error registering FCM token:', error);
    }
};

/**
 * Unregister FCM token for a user
 */
export const unregisterFCMToken = async (userId, token) => {
    try {
        const tokens = fcmTokenCache.get(userId);
        if (tokens) {
            tokens.delete(token);
        }

        const SupportUser = (await import('../model/supportUser.js')).default;
        const res = await SupportUser.findByIdAndUpdate(userId, {
            $pull: { fcmTokens: token }
        });

        if (!res) {
            const Admin = (await import('../model/Admin.js')).default;
            await Admin.findByIdAndUpdate(userId, {
                $pull: { fcmTokens: token }
            });
        }

    } catch (error) {
        console.error('Error unregistering FCM token:', error);
    }
};

/**
 * Send FCM push notification to a user
 */
export const sendFCMMessage = async (userId, notification) => {
    try {
        // Check if any Firebase app is initialized
        if (!appAdmin && !webAdmin) {
            return;
        }

        // Get User (SupportUser or Admin)
        const SupportUser = (await import('../model/supportUser.js')).default;
        const Admin = (await import('../model/Admin.js')).default;
        const WebNotificationToken = (await import('../model/WebNotificationToken.js')).default;

        let user = await SupportUser.findById(userId).select('fcmTokens deviceInfo').lean();
        let foundIn = 'SupportUser';

        if (!user) {
            user = await Admin.findById(userId).select('fcmTokens deviceInfo').lean();
            foundIn = 'Admin';
        }

        if (!user) {
            console.warn(`[FCM] User ${userId} NOT FOUND in any collection. Push notification skipped.`);
            return;
        }

        let tokens = user.fcmTokens || [];

        // If it's a SupportUser, also check for Web tokens
        if (foundIn === 'SupportUser') {
            const webTokens = await WebNotificationToken.find({ userId, isActive: true }).select('fcmToken').lean();
            if (webTokens.length > 0) {
                const fcmWebTokens = webTokens.map(t => t.fcmToken);
                tokens = [...new Set([...tokens, ...fcmWebTokens])]; // Unique tokens
            }
        }

        if (tokens.length === 0) {
            console.warn(`[FCM] No tokens found for user ${userId} (Found in ${foundIn}). Push notification skipped.`);
            return;
        }

        const validTokens = tokens.filter(token => token && token.length > 50);
        if (validTokens.length === 0) return;

        // Choose which Admin instance to use
        // If the user's platform is 'web', prioritize webAdmin if available
        const isWeb = user.deviceInfo?.platform === 'web';
        const activeAdmin = (isWeb && webAdmin) ? webAdmin : (appAdmin || webAdmin);

        if (!activeAdmin) return;

        // Build base message payload (without tokens)
        const Notification = (await import('../model/Notification.js')).default;
        const Project = (await import('../model/project.js')).default;

        const [unreadCount, project] = await Promise.all([
            Notification.countDocuments({ userId, read: false }),
            Project.findOne({ projectId: notification.projectId }).select('widgetConfig.logoUrl widgetConfig.primaryColor').lean()
        ]);

        const projectLogo = project?.widgetConfig?.logoUrl;
        const primaryColor = project?.widgetConfig?.primaryColor || '#2563eb';
        const notificationImage = notification.image || projectLogo;

        let cleanBody = String(notification.body || '');

        // Robust HTML cleaning for system fallback notifications
        const decodeEntities = (str) => {
            return str
                .replace(/&lt;/gi, '<')
                .replace(/&gt;/gi, '>')
                .replace(/&amp;/gi, '&')
                .replace(/&nbsp;/gi, ' ')
                .replace(/&quot;/gi, '"')
                .replace(/&#39;/gi, "'");
        };

        // Handle possible double-encoding (up to 2 passes)
        cleanBody = decodeEntities(cleanBody);
        if (cleanBody.includes('&')) {
            cleanBody = decodeEntities(cleanBody);
        }

        cleanBody = cleanBody
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/<\/div>/gi, '\n')
            .replace(/<\/li>/gi, '\n')
            .replace(/<div[^>]*>/gi, '\n')
            .replace(/<p[^>]*>/gi, '\n')
            .replace(/<li[^>]*>/gi, '\n')
            .replace(/<[^>]+>/g, '') // Strip all remaining tags
            .replace(/\n\s*\n/g, '\n')
            .trim();

        const baseMessage = {
            notification: {
                title: String(notification.title || 'New Message'),
                body: cleanBody,
                ...(notificationImage ? { image: String(notificationImage) } : {})
            },
            data: {
                type: String(notification.type || ''),
                chatId: String(notification.chatId || ''),
                projectId: String(notification.projectId || ''),
                notificationId: String(notification._id || ''),
                color: String(primaryColor), // Pass color to frontend
                logo: notificationImage ? String(notificationImage) : '', // Pass logo to frontend
                click_action: isWeb ? 'https://localhost:3000' : 'FLUTTER_NOTIFICATION_CLICK'
            },
            android: {
                priority: 'high',
                notification: {
                    sound: 'default',
                    channelId: 'chattie-notifications',
                    color: String(primaryColor), // Tint small icon and background
                    tag: notification.chatId ? String(notification.chatId) : 'chattie_general',
                    notification_count: Number(unreadCount), // Android Badge
                    ...(notificationImage ? {
                        imageUrl: String(notificationImage),
                        largeIcon: String(notificationImage) // Show project logo on the left/right
                    } : {})
                }
            },
            apns: {
                headers: { 'apns-priority': '10' },
                payload: { aps: { sound: 'default', badge: Number(unreadCount), 'mutable-content': 1 } }
            },
            webpush: {
                fcm_options: {
                    link: `${process.env.chatte_url || 'http://localhost:3000'}/support/dashboard?chatId=${notification.chatId}&projectId=${notification.projectId}`
                }
            }
        };

        // Send in chunks
        const chunkSize = 500;
        for (let i = 0; i < validTokens.length; i += chunkSize) {
            const tokensChunk = validTokens.slice(i, i + chunkSize);
            const multicastMessage = { ...baseMessage, tokens: tokensChunk };

            try {
                const response = await activeAdmin.messaging().sendEachForMulticast(multicastMessage);

                // Clean up invalid tokens
                const invalidTokens = [];
                response.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        if (resp.error.code === 'messaging/registration-token-not-registered' ||
                            resp.error.code === 'messaging/invalid-registration-token') {
                            invalidTokens.push(tokensChunk[idx]);
                        }
                    }
                });

                if (invalidTokens.length > 0) {
                    await SupportUser.findByIdAndUpdate(userId, {
                        $pull: { fcmTokens: { $in: invalidTokens } }
                    }).catch(console.error);
                }
            } catch (chunkError) {
                console.error('Error sending FCM chunk:', chunkError);
            }
        }
    } catch (error) {
        console.error('Error sending FCM message:', error);
    }
};

/**
 * Send FCM message to multiple users (bulk)
 */
export const sendFCMMessageBulk = async (userIds, notification) => {
    try {
        // Group tokens by user and send in parallel
        await Promise.allSettled(
            userIds.map(userId =>
                sendFCMMessage(userId, notification).catch(err => {
                    console.error(`Failed to send FCM to user ${userId}:`, err);
                })
            )
        );
    } catch (error) {
        console.error('Error in sendFCMMessageBulk:', error);
    }
};
