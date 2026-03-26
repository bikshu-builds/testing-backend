import admin from 'firebase-admin';

// Initialize Firebase Admin with service account
let serviceAccount;

try {
    // Option 0: Check for service-account.json in backend directory (common location)
    const fs = await import('fs');
    const path = await import('path');
    const defaultPath = path.join(process.cwd(), 'service-account.json');
    if (fs.existsSync(defaultPath)) {
        serviceAccount = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
    }
    // Option 1: Load from environment variable (JSON string)
    else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    }
    // Option 2: Load from file path
    else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
        const serviceAccountPath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
        serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    }
    // Option 3: Use individual env vars
    else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
        serviceAccount = {
            type: "service_account",
            project_id: process.env.FIREBASE_PROJECT_ID,
            private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            client_email: process.env.FIREBASE_CLIENT_EMAIL,
            client_id: process.env.FIREBASE_CLIENT_ID,
            auth_uri: process.env.FIREBASE_AUTH_URI || "https://accounts.google.com/o/oauth2/auth",
            token_uri: process.env.FIREBASE_TOKEN_URI || "https://oauth2.googleapis.com/token",
            auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL || "https://www.googleapis.com/oauth2/v1/certs",
            client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
        };
    }

    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } else {
        console.warn('Firebase credentials not found in environment. Push notifications will be disabled.');
    }
} catch (error) {
    console.error('Error initializing Firebase Admin:', error);
}

// In-memory cache for FCM tokens (also persist to DB)
const fcmTokenCache = new Map(); // userId -> Set of tokens

/**
 * Register FCM token for a user
 */
export const registerFCMToken = async (userId, token, platform = 'android', appVersion) => {
    try {
        if (!fcmTokenCache.has(userId)) {
            fcmTokenCache.set(userId, new Set());
        }
        fcmTokenCache.get(userId).add(token);

        // Save to SupportUser model
        const SupportUser = (await import('../model/supportUser.js')).default;
        await SupportUser.findByIdAndUpdate(userId, {
            $addToSet: { fcmTokens: token },
            $set: {
                'deviceInfo.platform': platform,
                'deviceInfo.appVersion': appVersion,
                'deviceInfo.lastSeen': new Date()
            }
        });

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
        await SupportUser.findByIdAndUpdate(userId, {
            $pull: { fcmTokens: token }
        });

    } catch (error) {
        console.error('Error unregistering FCM token:', error);
    }
};

/**
 * Send FCM push notification to a user
 */
export const sendFCMMessage = async (userId, notification) => {
    try {
        // Check if Firebase is initialized
        if (!admin.apps.length) {
            return;
        }

        // Get tokens from cache or DB
        let tokens = fcmTokenCache.get(userId);
        if (!tokens || tokens.size === 0) {
            const SupportUser = (await import('../model/supportUser.js')).default;
            const user = await SupportUser.findById(userId).select('fcmTokens').lean();

            if (!user || !user.fcmTokens || user.fcmTokens.length === 0) {
                console.warn(`[FCM] No tokens found for user ${userId}. Push notification skipped.`);
                return;
            }

            tokens = new Set(user.fcmTokens);
            fcmTokenCache.set(userId, tokens);
        }

        if (tokens.size === 0) {
            console.warn(`[FCM] No tokens cached for user ${userId}. Push notification skipped.`);
            return;
        }

        const validTokens = Array.from(tokens).filter(token =>
            token && (token.length > 50) // Basic validation
        );

        if (validTokens.length === 0) {
            console.warn(`[FCM] No valid tokens for user ${userId}. Push notification skipped.`);
            return;
        }

        // Build base message payload (without tokens)
        const Notification = (await import('../model/Notification.js')).default;
        const Project = (await import('../model/project.js')).default;

        const [unreadCount, project] = await Promise.all([
            Notification.countDocuments({ userId, read: false }),
            Project.findOne({ projectId: notification.projectId }).select('widgetConfig.logoUrl').lean()
        ]);

        const projectLogo = project?.widgetConfig?.logoUrl;
        const baseUrl = process.env.BASE_URL || (process.env.chatte_url ? process.env.chatte_url.replace('exp://', 'http://') : 'http://localhost:5000');
        const defaultLogo = `${baseUrl}/logo-bg.png`;
        const notificationImage = notification.image || projectLogo || defaultLogo;

        const baseMessage = {
            notification: {
                title: String(notification.title || 'New Message'),
                body: String(notification.body || ''),
                ...(notificationImage ? { image: String(notificationImage), icon: String(notificationImage) } : {})
            },
            data: {
                type: String(notification.type || ''),
                chatId: String(notification.chatId || ''),
                projectId: String(notification.projectId || ''),
                notificationId: String(notification._id || ''),
                click_action: 'FLUTTER_NOTIFICATION_CLICK'
            },
            android: {
                priority: 'high',
                notification: {
                    sound: 'default',
                    channelId: 'chattie-notifications',
                    color: '#ffffff',
                    icon: 'logo_bg',
                    tag: notification.chatId ? String(notification.chatId) : 'chattie_general',
                    notification_count: Number(unreadCount), // Android Badge
                    ...(notificationImage ? { imageUrl: String(notificationImage) } : {})
                }
            },
            apns: {
                headers: { 'apns-priority': '10' },
                payload: {
                    aps: {
                        sound: 'default',
                        badge: Number(unreadCount), // iOS Badge
                        'mutable-content': 1
                    }
                },
                fcm_options: {
                    ...(notificationImage ? { image: String(notificationImage) } : {})
                }
            }
        };

        // Send in chunks (FCM limits to 500 tokens per request for multicast)
        const chunkSize = 500;
        for (let i = 0; i < validTokens.length; i += chunkSize) {
            const tokensChunk = validTokens.slice(i, i + chunkSize);
            const multicastMessage = {
                ...baseMessage,
                tokens: tokensChunk
            };

            try {
                const response = await admin.messaging().sendEachForMulticast(multicastMessage);

                // Clean up invalid tokens
                const invalidTokens = [];
                response.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        const error = resp.error;
                        console.error(`FCM Delivery Error for token ${tokensChunk[idx].substring(0, 20)}...:`, error.code, error.message);
                        if (error.code === 'messaging/registration-token-not-registered' ||
                            error.code === 'messaging/invalid-registration-token' ||
                            error.code === 'messaging/unknown' ||
                            (error.code === 'messaging/internal-error' && error.message?.includes('registration token'))) {
                            invalidTokens.push(tokensChunk[idx]);
                        }
                    }
                });

                if (invalidTokens.length > 0) {
                    for (const t of invalidTokens) {
                        tokens.delete(t);
                    }
                    fcmTokenCache.set(userId, tokens);

                    // Also remove from DB
                    const SupportUser = (await import('../model/supportUser.js')).default;
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