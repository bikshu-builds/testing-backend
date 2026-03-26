(function () {
    const scriptTag = document.currentScript || document.querySelector("script[data-project-id]");
    if (!scriptTag) return console.error("Chattie: Project ID not found");

    const projectId = scriptTag.getAttribute("data-project-id");
    const API_BASE = scriptTag.src.split("/api/widget/bundle.js")[0];


    // Use a hardcoded key for the widget since it's client-side to ensure consistency across different host pages.
    const ENCRYPTION_KEY = "<<<MESSAGE_JWT_SECRET>>>";

    // Define storage keys early but logic comes later
    // Hashing project ID implies we need CryptoJS loaded, so we define keys inside promise callback


    let studentMessageCount = 0; // Track messages sent by student
    let unreadSupportMessagesCount = 0; // Track unread support messages for the icon count
    let emailPromptShown = false; // Track if we've shown the email prompt
    let pendingHistoryRestore = false; // Set to true when history is found and we re-join with old chatId
    let originalTitle = document.title || "Chat Support";
    let lastUnreadCount = 0;
    // Flag: true while chat_force_logout is being processed (prevents duplicate email prompts from session monitor)
    let sessionIsBeingReset = false;

    let socket = null;
    let root = null; // Declare root at a higher scope
    let messages = [];
    const allMessagesMap = new Map();




    // Secure Storage Variables (Initialized after dependencies load)
    let storageKeys = {};
    let secureStorage = {
        getItem: () => null,
        setItem: () => { },
        removeItem: () => { }
    };

    // Load Dependencies
    const loadScript = (src) => {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    };

    Promise.all([
        loadScript('https://cdn.socket.io/4.8.0/socket.io.min.js'),
        loadScript('https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js')
    ]).then(() => {

        // --- 1. Initialize Unique Secure Storage Keys ---

        // Helper to generate a unique hash for each key type
        const getUniqueHash = (salt) => CryptoJS.SHA256(projectId + salt + ENCRYPTION_KEY).toString(CryptoJS.enc.Hex).substring(0, 16);

        // Previous shared project hash (for migration)
        const projectHashLegacy = CryptoJS.SHA256(projectId).toString(CryptoJS.enc.Hex).substring(0, 16);

        storageKeys = {
            chatId: `chattie_xid_${getUniqueHash('chat')}`,
            userId: `chattie_uid_${getUniqueHash('user')}`,
            token: `chattie_tk_${getUniqueHash('token')}`,
            email: `chattie_em_${getUniqueHash('email')}`,
            name: `chattie_nm_${getUniqueHash('name')}`,
            unreadCount: `chattie_uc_${getUniqueHash('unread')}`
        };

        // Secure Storage Implementation
        secureStorage = {
            getItem: (key) => {
                try {
                    const item = localStorage.getItem(key);
                    if (!item) return null;
                    // Decrypt using our decryptMessage function (defined below/hoisted)
                    // If decryption fails/returns same string, we treat as invalid or literal
                    return decryptMessage(item);
                } catch (e) {
                    return null;
                }
            },
            setItem: (key, value) => {
                try {
                    const encrypted = encryptMessage(value);
                    localStorage.setItem(key, encrypted);
                } catch (e) {
                    console.error("Failed to save secure item", e);
                }
            },
            removeItem: (key) => localStorage.removeItem(key)
        };


        // --- 2. Initialize IDs (Migrate through all previous versions) ---
        let currentChatId = secureStorage.getItem(storageKeys.chatId);
        let currentUserId = secureStorage.getItem(storageKeys.userId);
        let savedUnreadCount = secureStorage.getItem(storageKeys.unreadCount);
        if (savedUnreadCount) unreadSupportMessagesCount = parseInt(savedUnreadCount) || 0;

        // Migration Version 2: From shared projectHash to unique hashes
        if (!currentChatId) {
            const oldHashChatKey = `chattie_xid_${projectHashLegacy}`;
            const v2ChatIdRaw = localStorage.getItem(oldHashChatKey);
            if (v2ChatIdRaw) {
                const v2ChatId = decryptMessage(v2ChatIdRaw);
                currentChatId = v2ChatId;
                secureStorage.setItem(storageKeys.chatId, currentChatId);
                localStorage.removeItem(oldHashChatKey);
            }
        }
        if (!currentUserId) {
            const oldHashUserKey = `chattie_uid_${projectHashLegacy}`;
            const v2UserIdRaw = localStorage.getItem(oldHashUserKey);
            if (v2UserIdRaw) {
                const v2UserId = decryptMessage(v2UserIdRaw);
                currentUserId = v2UserId;
                secureStorage.setItem(storageKeys.userId, currentUserId);
                localStorage.removeItem(oldHashUserKey);
            }
        }

        // Migrate Token, Email, and Name (Version 2)
        const oldHashTokenKey = `chattie_tk_${projectHashLegacy}`;
        const v2TokenRaw = localStorage.getItem(oldHashTokenKey);
        if (v2TokenRaw) {
            secureStorage.setItem(storageKeys.token, decryptMessage(v2TokenRaw));
            localStorage.removeItem(oldHashTokenKey);
        }

        const oldHashEmailKey = `chattie_em_${projectHashLegacy}`;
        const v2EmailRaw = localStorage.getItem(oldHashEmailKey);
        if (v2EmailRaw) {
            secureStorage.setItem(storageKeys.email, decryptMessage(v2EmailRaw));
            localStorage.removeItem(oldHashEmailKey);
        }

        const oldHashNameKey = `chattie_nm_${projectHashLegacy}`;
        const v2NameRaw = localStorage.getItem(oldHashNameKey);
        if (v2NameRaw) {
            secureStorage.setItem(storageKeys.name, decryptMessage(v2NameRaw));
            localStorage.removeItem(oldHashNameKey);
        }

        // Migration Version 1: From plain text keys (Legacy)
        if (!currentChatId) {
            const legacyChatId = localStorage.getItem(`chattie_chatId_${projectId}`);
            if (legacyChatId) {
                currentChatId = legacyChatId;
                secureStorage.setItem(storageKeys.chatId, currentChatId);
                localStorage.removeItem(`chattie_chatId_${projectId}`);
            }
        }
        if (!currentUserId) {
            const legacyUserId = localStorage.getItem(`chattie_userId_${projectId}`);
            if (legacyUserId) {
                currentUserId = legacyUserId;
                secureStorage.setItem(storageKeys.userId, currentUserId);
                localStorage.removeItem(`chattie_userId_${projectId}`);
            }
        }

        // Create New IDs if Missing
        if (!currentChatId) {
            currentChatId = `${projectId}_chat_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
            secureStorage.setItem(storageKeys.chatId, currentChatId);
        }
        if (!currentUserId) {
            currentUserId = `student_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
            secureStorage.setItem(storageKeys.userId, currentUserId);
        }

        // Set Global Scope Variables
        chatId = currentChatId;
        userId = currentUserId;


        // --- 3. Start Application Flow ---
        initializeSocket();
        fetchConfig(); // Call the fetch config logic here, ensuring deps are ready

    }).catch(err => console.error('❌ Failed to load dependencies', err));

    let projectConfig = null;
    let emailSettings = null;

    // Fetch Config (Wrapped in function to call after deps load)
    function fetchConfig() {
        if (!API_BASE || !projectId) return;

        // Remove old plaintext token if present (cleanup)
        localStorage.removeItem(`chattie_token_${projectId}`);

        fetch(`${API_BASE}/api/projects/public/${projectId}`)
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    projectConfig = data.project;
                    emailSettings = data.project.emailSetting || {};
                    initChattie(data.project.widgetConfig);
                    // Load messages after UI is initialized
                    loadMessages();
                    // Start monitoring for localStorage session loss (no-refresh detection)
                    startSessionMonitor();
                } else {
                    console.error("Chattie: Project not found");
                }
            })
            .catch(err => console.error("Chattie: Failed to load", err));
    }






    function encryptMessage(text) {
        if (!text) return "";
        try {
            const iv = CryptoJS.lib.WordArray.random(16);
            const encKey = CryptoJS.SHA256(ENCRYPTION_KEY);
            const encrypted = CryptoJS.AES.encrypt(text, encKey, {
                iv: iv,
                mode: CryptoJS.mode.CBC,
                padding: CryptoJS.pad.Pkcs7
            });

            const ivHex = iv.toString(CryptoJS.enc.Hex);
            const cipherB64 = encrypted.ciphertext.toString(CryptoJS.enc.Base64);

            // HMAC-SHA256 over IV + ciphertext (Encrypt-then-MAC)
            // CRITICAL: Convert hex-string hash to WordArray of raw bytes to match backend's Buffer.digest() format
            const macKeyHex = CryptoJS.SHA256(ENCRYPTION_KEY + '|mac').toString(CryptoJS.enc.Hex);
            const macKeyWords = CryptoJS.enc.Hex.parse(macKeyHex);
            const hmac = CryptoJS.HmacSHA256(ivHex + '|' + cipherB64, macKeyWords)
                .toString(CryptoJS.enc.Hex);

            return `mac|${ivHex}|${hmac}|${cipherB64}`;
        } catch (error) {
            console.error("Encryption failed:", error);
            return text;
        }
    }

    function decryptMessage(encryptedText) {
        if (!encryptedText) return "";
        try {
            // ── New format: mac|iv|hmac|ciphertext (Encrypt-then-MAC) ──────────
            if (encryptedText.startsWith('mac|')) {
                const parts = encryptedText.split('|');
                if (parts.length !== 4) return encryptedText;
                const [, ivHex, receivedHmac, cipherB64] = parts;

                // 1. Verify HMAC FIRST — reject if tampered (no decryption attempted)
                // CRITICAL: Convert hex-string hash to WordArray of raw bytes to match backend's Buffer.digest() format
                const macKeyHex = CryptoJS.SHA256(ENCRYPTION_KEY + '|mac').toString(CryptoJS.enc.Hex);
                const macKeyWords = CryptoJS.enc.Hex.parse(macKeyHex);
                const expectedHmac = CryptoJS.HmacSHA256(ivHex + '|' + cipherB64, macKeyWords)
                    .toString(CryptoJS.enc.Hex);

                if (receivedHmac !== expectedHmac) {
                    console.error("HMAC verification failed — possible tampering");
                    return encryptedText; // Reject without decrypting
                }

                // 2. HMAC passed — safe to decrypt
                const iv = CryptoJS.enc.Hex.parse(ivHex);
                const encKey = CryptoJS.SHA256(ENCRYPTION_KEY);
                const params = CryptoJS.lib.CipherParams.create({
                    ciphertext: CryptoJS.enc.Base64.parse(cipherB64)
                });
                const decrypted = CryptoJS.AES.decrypt(params, encKey, {
                    iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7
                });
                return decrypted.toString(CryptoJS.enc.Utf8) || encryptedText;
            }

            // ── Guard: gcm| format — not decryptable here, return as-is ───────
            if (encryptedText.startsWith('gcm|')) return encryptedText;

            // ── Legacy: old bare-CBC formats (pipe or colon delimiter) ─────────
            let ivHex, cipherText;
            if (encryptedText.includes('|')) {
                const idx = encryptedText.indexOf('|');
                ivHex = encryptedText.slice(0, idx);
                cipherText = encryptedText.slice(idx + 1);
            } else if (encryptedText.includes(':')) {
                const idx = encryptedText.indexOf(':');
                ivHex = encryptedText.slice(0, idx);
                cipherText = encryptedText.slice(idx + 1);
            } else {
                return encryptedText;
            }
            if (!ivHex || !cipherText) return encryptedText;
            const iv = CryptoJS.enc.Hex.parse(ivHex);
            const encKey = CryptoJS.SHA256(ENCRYPTION_KEY);
            const params = CryptoJS.lib.CipherParams.create({
                ciphertext: CryptoJS.enc.Base64.parse(cipherText)
            });
            const decrypted = CryptoJS.AES.decrypt(params, encKey, {
                iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7
            });
            return decrypted.toString(CryptoJS.enc.Utf8) || encryptedText;
        } catch {
            return encryptedText;
        }
    }

    let isSyncingMessages = false;
    function loadMessages() {
        if (!projectId || !chatId || isSyncingMessages) return;
        const chatBody = document.querySelector("#chattie-body");
        const token = secureStorage.getItem(storageKeys.token);
        if (!chatBody || !token) {
            // Either UI or Auth not ready. The other trigger will call us.
            return;
        }

        isSyncingMessages = true;
        const headers = {};
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }

        fetch(`${API_BASE}/api/messages/${projectId}/${chatId}?sortOrder=desc&limit=2000`, {
            headers
        })
            .then(res => res.json())
            .then(data => {
                const chatBody = document.querySelector("#chattie-body");
                if (data.success && data.messages && data.messages.length > 0) {
                    // Clear the static welcome message if history exists
                    if (chatBody) chatBody.innerHTML = '';

                    // Reset date tracking before load
                    lastRenderedDate = null;
                    unreadSupportMessagesCount = 0; // Reset count

                    const chatWindow = document.querySelector('.chattie-window');
                    const isWindowOpen = chatWindow && chatWindow.classList.contains('open');

                    // Reverse descending messages so newest are at the bottom
                    let msgsToRender = data.messages.reverse();

                    // Filter messages to only show those after the last "restart" system message
                    let startIndex = 0;
                    for (let i = msgsToRender.length - 1; i >= 0; i--) {
                        let msgText = msgsToRender[i].message;
                        if (msgsToRender[i].messageType === 'text' && msgText && (msgText.includes('|') || msgText.includes(':'))) {
                            try { msgText = decryptMessage(msgText); } catch (e) { }
                        }

                        if (msgsToRender[i].senderType === 'system' && msgText === "New conversation started...") {
                            startIndex = i;
                            break;
                        }
                    }
                    if (startIndex > 0) {
                        msgsToRender = msgsToRender.slice(startIndex);
                    }

                    msgsToRender.forEach(msg => {
                        let content = msg.message;
                        if (msg.messageType === 'text' && content) {
                            if (content.includes('|') || content.includes(':')) {
                                content = decryptMessage(content);
                            }
                        }
                        addMessageToUI(
                            content,
                            msg.senderType,
                            msg.createdAt,
                            msg.messageType,
                            msg.fileUrl,
                            msg.status,
                            msg._id,
                            true,
                            msg.replyTo,
                            msg.reactions || [],
                            msg.showRating,
                            msg.isDeleted || false
                        );

                        // Count unread support msgs
                        if (msg.senderType === 'support' && msg.status !== 'seen') {
                            if (isWindowOpen) {
                                // If window is open, mark it as read immediately
                                if (socket && socket.connected) {
                                    const readPayload = { messageId: msg._id, projectId };
                                    const readToken = encryptMessage(JSON.stringify(readPayload));
                                    socket.emit('message_read', { token: readToken });
                                }
                            } else {
                                unreadSupportMessagesCount++;
                            }
                        }
                    });

                    if (!isWindowOpen) {
                        updateUnreadIndicator();
                    }

                    setTimeout(() => {
                        const cb = document.querySelector("#chattie-body");
                        if (cb) cb.scrollTop = cb.scrollHeight;
                        isSyncingMessages = false;
                    }, 50);
                } else {
                    isSyncingMessages = false;
                }
            })
            .catch(err => {
                console.error("Chattie: Failed to load messages", err);
                isSyncingMessages = false;
            });
    }

    function markAllAsRead() {
        if (!projectId || !chatId || !userId) return;

        unreadSupportMessagesCount = 0;
        updateUnreadIndicator();

        const token = secureStorage.getItem(storageKeys.token);
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        fetch(`${API_BASE}/api/messages/${projectId}/${chatId}/mark-read/${userId}`, {
            method: 'PUT',
            headers
        }).catch(err => console.error("Chattie: Failed to mark messages as read", err));
    }

    function updateUnreadIndicator() {
        const unreadIndicator = document.querySelector("#chattie-unread-indicator");
        if (unreadIndicator) {
            unreadIndicator.innerText = unreadSupportMessagesCount;
            unreadIndicator.style.display = unreadSupportMessagesCount > 0 ? "flex" : "none";
        }

        // --- NEW: TAB TITLE NOTIFICATION ---
        const chatWindow = document.querySelector('.chattie-window');
        const isWindowOpen = chatWindow && chatWindow.classList.contains('open');

        if (unreadSupportMessagesCount > 0 && (!isWindowOpen || document.hidden)) {
            document.title = `(${unreadSupportMessagesCount}) ${originalTitle}`;
            if (unreadSupportMessagesCount > lastUnreadCount) {
                playNotificationSound();
            }
        } else {
            document.title = originalTitle;
        }
        lastUnreadCount = unreadSupportMessagesCount;

        if (secureStorage && storageKeys.unreadCount) {
            secureStorage.setItem(storageKeys.unreadCount, unreadSupportMessagesCount.toString());
        }
    }

    function playNotificationSound() {
        try {
            const audio = new Audio("https://assets.mixkit.co/active_storage/sfx/2358/2358-preview.mp3");
            audio.volume = 0.5;
            audio.play().catch(e => {
                // Audio play might be blocked if user hasn't interacted yet
                // We'll ignore silently as it's a known browser restriction
            });
        } catch (e) {
            console.error("Chattie: Failed to play notification sound", e);
        }
    }

    function initializeSocket() {
        if (typeof io === 'undefined') {
            console.error('Socket.IO not loaded');
            return;
        }

        socket = io(API_BASE, {
            transports: ['websocket', 'polling'],
            reconnection: true,
        });

        socket.on('connect', () => {


            // Check if email is already stored

            // Cleanup old plain keys if present
            localStorage.removeItem(`chattie_email_${projectId}`);
            localStorage.removeItem(`chattie_name_${projectId}`);

            let storedEmail = secureStorage.getItem(storageKeys.email);
            let storedName = secureStorage.getItem(storageKeys.name);

            // Capture Metadata
            const metadata = {
                userAgent: navigator.userAgent,
                language: navigator.language,
                platform: navigator.platform,
                screenResolution: `${window.screen.width}x${window.screen.height}`,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                referrer: document.referrer,
                currentUrl: window.location.href,
                browser: getBrowserName(),
                os: getOSName(),
                device: getDeviceType(),
                email: storedEmail,
                name: storedName
            };

            // Join chat room immediately (no blocking modal)
            const payload = {
                projectId,
                chatId,
                userId,
                userType: 'student',
                metadata
            };
            const token = encryptMessage(JSON.stringify(payload));
            socket.emit('join_chat', { token });
        });

        socket.on('chat_force_logout', (data) => {
            try {
                const decryptedToken = decryptMessage(data.token);
                const payload = JSON.parse(decryptedToken);
                if (payload.action === 'clear_session') {
                    // ── Bug #2 fix: set flag FIRST so startSessionMonitor doesn't
                    // race-show the inline email form during the reconnect window
                    sessionIsBeingReset = true;

                    // Remove all chattie keys
                    if (storageKeys) {
                        Object.values(storageKeys).forEach(key => localStorage.removeItem(key));
                    }

                    // Generate new IDs so old messages aren't fetched again
                    chatId = `${projectId}_chat_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
                    userId = `student_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;

                    secureStorage.setItem(storageKeys.chatId, chatId);
                    secureStorage.setItem(storageKeys.userId, userId);

                    // Clear the chat UI in-place instead of reloading the page
                    const chatBody = document.querySelector("#chattie-body");
                    if (chatBody) {
                        chatBody.innerHTML = '';
                    }

                    // Reset widget local state completely
                    lastRenderedDate = null;
                    widgetReplyingToId = null;
                    isRatingPending = false;
                    messages = [];
                    if (typeof allMessagesMap !== 'undefined') allMessagesMap.clear();

                    // Reset unread count cleanly
                    unreadSupportMessagesCount = 0;
                    if (storageKeys && storageKeys.unreadCount) {
                        secureStorage.setItem(storageKeys.unreadCount, '0');
                    }
                    if (typeof updateUnreadIndicator === 'function') {
                        updateUnreadIndicator();
                    }

                    // Disconnect and reconnect socket to ensure a perfectly clean start
                    if (socket) {
                        socket.disconnect();
                        setTimeout(() => {
                            clearWidgetReplyBar(true);
                            initializeSocket();
                            // Release the reset flag after socket is reconnected so
                            // session monitor can start watching for the new session
                            setTimeout(() => { sessionIsBeingReset = false; }, 3000);
                        }, 500);
                    }
                }
            } catch (e) {
                console.error('Error handling force logout:', e);
            }
        });

        socket.on('error', (error) => {
            console.error('Socket error details:', JSON.stringify(error, Object.getOwnPropertyNames(error)));

            if (error.code === 'RATING_REQUIRED') {
                // Always enforce the UI block when the backend rejects the message
                disableMessagingForRating();
                const ratingBlocks = document.querySelectorAll('[id^="rating-block-"]');
                if (ratingBlocks.length > 0) {
                    const lastRatingBlock = ratingBlocks[ratingBlocks.length - 1];
                    lastRatingBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    lastRatingBlock.style.transition = 'box-shadow 0.3s';
                    lastRatingBlock.style.boxShadow = '0 0 20px rgba(79, 70, 229, 0.5)';
                    setTimeout(() => lastRatingBlock.style.boxShadow = '0 4px 12px rgba(0,0,0,0.05)', 3000);
                }
            }

            // If email is required or invalid, show the prompt again
            if (error.code === 'EMAIL_REQUIRED' || error.code === 'INVALID_EMAIL') {


                showEmailPrompt((email, name, skipped) => {
                    if (email) {
                        const lowerEmail = email.toLowerCase().trim();
                        checkHistoryAndResume(lowerEmail, name, (finalEmail, finalName) => {
                            secureStorage.setItem(storageKeys.email, finalEmail);
                            if (finalName) secureStorage.setItem(storageKeys.name, finalName);

                            const metadata = {
                                browser: getBrowserName(),
                                os: getOSName(),
                                device: getDeviceType(),
                                currentUrl: window.location.href,
                                email: finalEmail,
                                name: finalName
                            };

                            const payload = {
                                projectId,
                                chatId,
                                userId,
                                userType: 'student',
                                metadata
                            };
                            const token = encryptMessage(JSON.stringify(payload));
                            socket.emit('join_chat', { token });
                        });
                    }
                }, error.emailSettings?.isEmailMandatory || true, error.message);
            }
        });

        function getBrowserName() {
            const userAgent = navigator.userAgent;
            if (userAgent.match(/chrome|chromium|crios/i)) return "Chrome";
            if (userAgent.match(/firefox|fxios/i)) return "Firefox";
            if (userAgent.match(/safari/i)) return "Safari";
            if (userAgent.match(/opr\//i)) return "Opera";
            if (userAgent.match(/edg/i)) return "Edge";
            return "Unknown";
        }

        function getOSName() {
            const userAgent = navigator.userAgent;
            if (userAgent.match(/android/i)) return "Android";
            if (userAgent.match(/iphone|ipad|ipod/i)) return "iOS";
            if (userAgent.match(/windows/i)) return "Windows";
            if (userAgent.match(/mac/i)) return "MacOS";
            if (userAgent.match(/linux/i)) return "Linux";
            return "Unknown";
        }

        function getDeviceType() {
            const userAgent = navigator.userAgent;
            if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(userAgent)) return "Tablet";
            if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(userAgent)) return "Mobile";
            return "Desktop";
        }

        let hasInitialLoad = false;
        socket.on('joined_chat', (data) => {
            if (data.token) {
                try {
                    const decryptedJSON = decryptMessage(data.token);
                    const response = JSON.parse(decryptedJSON);
                    if (response.token) {
                        secureStorage.setItem(storageKeys.token, response.token);
                        if (!hasInitialLoad || pendingHistoryRestore) {
                            hasInitialLoad = true;
                            if (pendingHistoryRestore) {
                                // History restore: clear leftover UI then fetch old messages
                                pendingHistoryRestore = false;
                                const chatBody = document.querySelector('#chattie-body');
                                if (chatBody) chatBody.innerHTML = '';
                                lastRenderedDate = null;
                            }
                            loadMessages();
                        }
                    }
                } catch (e) {
                    console.error('❌ Failed to decrypt joined_chat:', e);
                }
            }
        });

        socket.on('new_message', (data) => {
            let message = data;
            if (data.token && !data._id) {
                try {
                    const decryptedJSON = decryptMessage(data.token);
                    message = JSON.parse(decryptedJSON);
                } catch (e) {
                    console.error('❌ Failed to decrypt new_message:', e);
                    return;
                }
            }
            handleNewMessage(message);
        });

        function handleNewMessage(message) {

            // Check if message already exists to avoid duplicates
            if (document.querySelector(`.chattie-message-group[data-id="${message._id}"]`)) return;

            // Skip deleted rating messages — they should never render a rating block
            if (message.isDeleted && message.showRating) return;

            let content = message.message;
            if (message.messageType === 'text') {
                // Check if it's double encrypted (legacy or layer)
                if (content.includes('|') || content.includes(':')) {
                    const decryptedContent = decryptMessage(content);
                    // If decryption returns same string (failure) or garbage, stick to original?
                    // Our decryptMessage returns original on failure.
                    content = decryptedContent;
                }
            }

            addMessageToUI(content, message.senderType, message.createdAt, message.messageType, message.fileUrl, message.status, message._id, false, message.replyTo, message.reactions || [], message.showRating, message.isDeleted || false);

            // If message is from support or admin, mark as delivered
            if (message.senderType === 'support' || message.senderType === 'admin') {
                const deliveredPayload = { messageId: message._id, projectId };
                const deliveredToken = encryptMessage(JSON.stringify(deliveredPayload));
                socket.emit('message_delivered', { token: deliveredToken });

                // If window is open, mark as read
                const chatWindow = document.querySelector('.chattie-window');
                const isWindowOpen = chatWindow && chatWindow.classList.contains('open');

                if (isWindowOpen) {
                    const readPayload = { messageId: message._id, projectId };
                    const readToken = encryptMessage(JSON.stringify(readPayload));
                    socket.emit('message_read', { token: readToken });
                } else {
                    // WINDOW CLOSED: Show count on the icon
                    unreadSupportMessagesCount++;
                    updateUnreadIndicator();

                    // Shake animation for attention
                    const toggleBtn = document.querySelector('.chattie-toggle');
                    if (toggleBtn) {
                        toggleBtn.animate([
                            { transform: 'scale(1)' },
                            { transform: 'scale(1.1) rotate(5deg)' },
                            { transform: 'scale(1.1) rotate(-5deg)' },
                            { transform: 'scale(1)' }
                        ], { duration: 300 });
                    }
                }
            }
        }

        socket.on('message_status_updated', (data) => {
            let payload = data;
            if (data && data.token) {
                try {
                    payload = JSON.parse(decryptMessage(data.token));
                } catch (e) {
                    console.error('Failed to decrypt message_status_updated:', e);
                    return;
                }
            }
            const { messageId, status } = payload;
            const messageGroup = document.querySelector(`.chattie-message-group[data-id="${messageId}"]`);
            if (messageGroup) {
                const tickContainer = messageGroup.querySelector('.chattie-tick-container');
                if (tickContainer) {
                    tickContainer.innerHTML = getTickIcon(status);
                    tickContainer.style.color = status === 'seen' ? '#34B7F1' : '#94a3b8';
                }
            }
        });

        socket.on('messages_marked_read', (data) => {
            let payload = data;
            if (data && data.token) {
                try {
                    payload = JSON.parse(decryptMessage(data.token));
                } catch (e) {
                    console.error('Failed to decrypt messages_marked_read:', e);
                    return;
                }
            }
            const { chatId: readChatId, userId: readerUserId } = payload;

            // Only update student messages to 'seen' if someone ELSE (admin/support) marked them read
            if (String(readChatId) === String(chatId) && String(readerUserId) !== String(userId)) {
                document.querySelectorAll('.chattie-message-group.student').forEach(group => {
                    const status = group.getAttribute('data-status');
                    if (status !== 'seen') {
                        group.setAttribute('data-status', 'seen');
                        const tickContainer = group.querySelector('.chattie-tick-container');
                        if (tickContainer) {
                            // Ensure we use getTickIcon if defined, else fallback to standard tick html
                            tickContainer.innerHTML = typeof getTickIcon === 'function' ? getTickIcon('seen') : tickContainer.innerHTML;
                            tickContainer.style.color = '#34B7F1';
                        }
                    }
                });
            }
        });

        socket.on('message_updated', (data) => {
            let message = data;
            if (data.token) {
                try {
                    const decryptedJSON = decryptMessage(data.token);
                    if (decryptedJSON !== data.token) {
                        message = JSON.parse(decryptedJSON);
                    }
                } catch (e) {
                    console.error('Failed to decrypt message_updated:', e);
                    return;
                }
            }
            handleMessageUpdated(message);
        });

        function handleMessageUpdated(message) {

            const messageGroup = document.querySelector(`.chattie-message-group[data-id="${message._id}"]`);
            if (messageGroup) {
                // Update content if text
                if (message.messageType === 'text') {
                    let content = message.message;
                    if (content.includes('|') || content.includes(':')) {
                        content = decryptMessage(content);
                    }
                    const bubble = messageGroup.querySelector('.chattie-bubble');
                    if (bubble) {
                        const cleanContent = chattieLinkify(sanitizeInput(content));
                        // Update only the text node, not the entire bubble (preserves chevron/dropdown)
                        let textNode = bubble.querySelector('.chattie-bubble-text');
                        if (textNode) {
                            textNode.innerHTML = cleanContent;
                        } else {
                            // Support for fallback if textNode is missing
                            bubble.childNodes.forEach(node => {
                                if (node.nodeType === Node.TEXT_NODE) node.remove();
                            });
                            bubble.insertAdjacentHTML('afterbegin', cleanContent);
                        }
                    }
                }

                // Update ticks if status changed (less likely for update, but possible)
                if (message.status) {
                    const tickContainer = messageGroup.querySelector('.chattie-tick-container');
                    if (tickContainer) {
                        tickContainer.innerHTML = getTickIcon(message.status);
                    }
                }

                // Update reactions
                if (message.reactions) {
                    const bubble = messageGroup.querySelector('.chattie-bubble');
                    if (bubble && bubble.parentElement) {
                        const wrapper = bubble.parentElement;
                        let reactionContainer = wrapper.querySelector('.chattie-reaction-container');
                        if (reactionContainer) {
                            reactionContainer.remove();
                        }

                        if (message.reactions.length > 0) {
                            const newRc = document.createElement('div');
                            newRc.className = 'chattie-reaction-container';
                            newRc.style.cssText = `
                                display: flex;
                                flex-direction: row;
                                flex-wrap: wrap;
                                gap: 2px;
                                margin-top: -8px;
                                margin-bottom: 2px;
                                z-index: 10;
                                align-self: ${messageGroup.classList.contains('student') ? 'flex-end' : 'flex-start'};
                                position: relative;
                            `;

                            const grouped = {};
                            message.reactions.forEach(r => {
                                grouped[r.emoji] = (grouped[r.emoji] || 0) + 1;
                            });

                            Object.entries(grouped).forEach(([emoji, count]) => {
                                const badge = document.createElement('div');
                                badge.style.cssText = `
                                    background: #ffffff;
                                    border: 1px solid #e2e8f0;
                                    border-radius: 12px;
                                    padding: 2px 6px;
                                    font-size: 11px;
                                    color: #475569;
                                    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
                                    display: flex;
                                    align-items: center;
                                    gap: 4px;
                                `;
                                badge.innerHTML = `<span>${emoji}</span><span>${count}</span>`;
                                newRc.appendChild(badge);
                            });

                            wrapper.appendChild(newRc);
                        }
                    }
                }
            }
        }

        socket.on('message_deleted', ({ messageId, deleteType, userId: deletedByUserId }) => {


            // logic to handle delete for me vs everyone
            // If deleteType === 'me' and the deleter is NOT the current user, ignore it.
            if (deleteType === 'me' && deletedByUserId !== userId) {
                return;
            }

            const messageGroup = document.querySelector(`.chattie-message-group[data-id="${messageId}"]`);
            if (messageGroup) {
                // Use .chattie-bubble as the selector, it applies to both student and support bubbles
                const messageBubble = messageGroup.querySelector('.chattie-bubble');
                if (messageBubble) {
                    messageBubble.innerHTML = '<span style="font-style: italic; opacity: 0.8; font-size: 13px;">This message was deleted</span>';
                    messageBubble.style.background = '#f1f5f9';
                    messageBubble.style.color = '#64748b';
                    messageBubble.style.border = '1px solid #e2e8f0';
                    messageBubble.style.boxShadow = 'none';

                    // Also remove ticks
                    const tickContainer = messageGroup.querySelector('.chattie-tick-container');
                    if (tickContainer) tickContainer.remove();
                } else {
                    console.warn('⚠️ Bubble not found for deleted message:', messageId);
                }
            } else {
                console.warn('⚠️ Message group not found for deletion:', messageId);
            }
        });



        // ── Bug #4 fix: listen for chat_status_changed so the widget UI updates
        // IMMEDIATELY when the chat is auto-resolved, before chat_force_logout fires
        socket.on('chat_status_changed', (data) => {
            try {
                let payload = data;
                if (data && data.token) {
                    const decrypted = decryptMessage(data.token);
                    payload = JSON.parse(decrypted);
                }
                if (payload.chatId === chatId) {
                    if (payload.status === 'resolved') {
                        disableMessageInputForResolution();
                        // Hide any active rating cards immediately upon resolution
                        const ratingBlocks = document.querySelectorAll('[id^="rating-block-"]');
                        ratingBlocks.forEach(block => {
                            block.style.opacity = "0";
                            block.style.transform = "scale(0.95)";
                            block.style.transition = "all 0.3s ease";
                            setTimeout(() => block.remove(), 300);
                        });
                        enableMessagingAfterRating(); // Unblock input so they can type to re-open
                    } else if ((payload.pendingRatingCount || 0) > 0 || payload.ratingRequested) {
                        // A rating is still required — keep the input blocked
                        disableMessagingForRating();
                    } else {
                        enableMessageInput();
                    }
                }
            } catch (e) {
                console.error('Error handling chat_status_changed:', e);
            }
        });

        socket.on('disconnect', () => {

        });
    }

    // Email Prompt Modal
    function checkHistoryAndResume(email, name, callback) {
        if (!email || email === 'skipped') {
            return callback(email, name);
        }

        fetch(`${API_BASE}/api/projects/history/${projectId}/${encodeURIComponent(email)}`)
            .then(res => res.json())
            .then(data => {
                if (data.success && data.chatId && data.userId) {
                    // Found history! Update in-memory IDs and rejoin socket (no page reload)
                    chatId = data.chatId;
                    userId = data.userId;

                    secureStorage.setItem(storageKeys.chatId, data.chatId);
                    secureStorage.setItem(storageKeys.userId, data.userId);
                    secureStorage.setItem(storageKeys.email, email.toLowerCase().trim());
                    if (data.name) secureStorage.setItem(storageKeys.name, data.name);

                    // Clear old token so fresh one is issued for restored chatId
                    secureStorage.removeItem(storageKeys.token);

                    // ── Bug #3 fix: Dismiss any full-screen modal overlay that may
                    // have appeared simultaneously from the EMAIL_REQUIRED socket error
                    const modalOverlay = document.getElementById('chattie-email-overlay');
                    if (modalOverlay) modalOverlay.remove();

                    // Show a brief success flash in the inline form before removing it,
                    // so the student gets clear visual feedback that their history was found
                    const inlineForm = document.getElementById('chattie-inline-form-container');
                    if (inlineForm) {
                        inlineForm.innerHTML = `
                            <div style="text-align: center; padding: 20px; color: #10b981; font-size: 14px; display: flex; flex-direction: column; align-items: center; gap: 8px;">
                                <div style="width: 32px; height: 32px; background: #ecfdf5; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                </div>
                                <span style="font-weight: 500; color: #059669;">Welcome back! Loading your conversation...</span>
                            </div>
                        `;
                        setTimeout(() => inlineForm.remove(), 2000);
                    }

                    // Clear chat body (remove new-session welcome messages)
                    const chatBody = document.querySelector('#chattie-body');
                    if (chatBody) chatBody.innerHTML = '';

                    // Handle resolved state immediately if history is already finished
                    if (data.status === 'resolved') {
                        disableMessageInputForResolution();
                    } else if ((data.pendingRatingCount || 0) > 0 || data.ratingRequested) {
                        // Rating still pending — keep input blocked
                        disableMessagingForRating();
                    } else {
                        enableMessageInput();
                    }

                    // Signal joined_chat handler to load messages after new token arrives
                    pendingHistoryRestore = true;

                    // Rejoin socket with the restored chatId
                    const restoredEmail = secureStorage.getItem(storageKeys.email);
                    const restoredName = secureStorage.getItem(storageKeys.name);
                    const joinPayload = {
                        projectId,
                        chatId: data.chatId,
                        userId: data.userId,
                        userType: 'student',
                        isExplicitRestore: true, // Flag to prevent auto-wipe of resolved chats
                        metadata: {
                            email: restoredEmail,
                            name: restoredName,
                            browser: navigator.userAgent,
                            currentUrl: window.location.href
                        }
                    };
                    const joinToken = encryptMessage(JSON.stringify(joinPayload));
                    socket.emit('join_chat', { token: joinToken });
                } else {
                    // No history, proceed as new visitor
                    callback(email, name);
                }
            })
            .catch(err => {
                console.error("Chattie: History check failed", err);
                callback(email, name);
            });
    }

    function showEmailPrompt(callback, isMandatory = true, customMessage = null) {
        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.id = 'chattie-email-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            z-index: 99999;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background: white;
            border-radius: 16px;
            padding: 32px;
            max-width: 400px;
            width: 90%;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        `;

        modal.innerHTML = `
            <h2 style="margin: 0 0 8px 0; font-size: 24px; color: #1e293b;">Welcome! 👋</h2>
            <p style="margin: 0 0 24px 0; color: #64748b; font-size: 14px;">
                ${customMessage || 'Please enter your email to start chatting with us.'}
            </p>
            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 6px; font-size: 13px; font-weight: 500; color: #475569;">
                    Name (optional)
                </label>
                <input
                    type="text"
                    id="chattie-name-input"
                    placeholder="Your name"
                    style="width: 100%; padding: 12px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 14px; box-sizing: border-box; outline: none;"
                />
            </div>
            <div style="margin-bottom: 24px;">
                <label style="display: block; margin-bottom: 6px; font-size: 13px; font-weight: 500; color: #475569;">
                    Email ${isMandatory ? '<span style="color: #ef4444;">*</span>' : '(optional)'}
                </label>
                <input
                    type="email"
                    id="chattie-email-input"
                    placeholder="you@example.com"
                    style="width: 100%; padding: 12px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 14px; box-sizing: border-box; outline: none;"
                />
                <div id="chattie-email-error" style="color: #ef4444; font-size: 12px; margin-top: 6px; display: none;"></div>
            </div>
            <div style="display: flex; gap: 12px;">
                ${!isMandatory ? '<button id="chattie-skip-btn" style="flex: 1; padding: 12px; border: 1px solid #e2e8f0; background: white; color: #64748b; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer;">Skip</button>' : ''}
                <button id="chattie-submit-email" style="flex: 1; padding: 12px; border: none; background: #4f46e5; color: white; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer;">
                    Start Chat
                </button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const emailInput = document.getElementById('chattie-email-input');
        const nameInput = document.getElementById('chattie-name-input');
        const submitBtn = document.getElementById('chattie-submit-email');
        const skipBtn = document.getElementById('chattie-skip-btn');
        const errorDiv = document.getElementById('chattie-email-error');

        function validateEmail(email) {
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        }

        function handleSubmit() {
            const email = emailInput.value.trim().toLowerCase();
            const name = nameInput.value.trim();

            if (isMandatory && !email) {
                errorDiv.textContent = 'Email is required';
                errorDiv.style.display = 'block';
                emailInput.style.borderColor = '#ef4444';
                return;
            }

            if (email && !validateEmail(email)) {
                errorDiv.textContent = 'Please enter a valid email address';
                errorDiv.style.display = 'block';
                emailInput.style.borderColor = '#ef4444';
                return;
            }

            document.body.removeChild(overlay);
            callback(email || null, name || null, false);
        }

        submitBtn.addEventListener('click', handleSubmit);
        emailInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleSubmit();
        });

        if (skipBtn) {
            skipBtn.addEventListener('click', () => {
                document.body.removeChild(overlay);
                callback(null, null, true);
            });
        }

        // Focus email input
        setTimeout(() => emailInput.focus(), 100);
    }

    // Show inline email prompt inside chat window (after first message)
    function showInlineChatEmailPrompt() {
        const chatBody = document.querySelector("#chattie-body");
        if (!chatBody) return;

        const isEmailMandatory = true; // Forced mandatory
        const emailMessage = emailSettings?.emailMessage || 'Please enter your email to continue';



        // Create inline email form as a bot message with 2 steps
        const formHTML = `
            <div id="chattie-inline-form-container" style="
                margin: 16px 4px;
                padding: 20px;
                background: white;
                border-radius: 12px;
                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
                border: 1px solid #f1f5f9;
                color: #334155;
                font-family: inherit;
                animation: chattie-slide-in 0.3s ease-out;
            ">
                <div style="margin-bottom: 16px; display: flex; align-items: center; gap: 10px;">
                    <div style="width: 36px; height: 36px; background: #f8fafc; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: #4f46e5;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
                    </div>
                    <div>
                        <div style="font-weight: 600; font-size: 14px; color: #0f172a;">Contact Details</div>
                        <div style="font-size: 11px; color: #64748b;">So we can stay in touch</div>
                    </div>
                </div>

                <!-- STEP 1: EMAIL -->
                <div id="chattie-step-1">
                    <p style="margin: 0 0 12px 0; font-size: 13px; color: #475569; line-height: 1.5;">
                        ${emailMessage}
                    </p>
                    <div style="margin-bottom: 16px;">
                        <input
                            type="email"
                            id="chattie-email-input"
                            placeholder="name@example.com"
                            style="width: 100%; padding: 12px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 14px; outline: none; transition: all 0.2s; background: #f8fafc; color: #1e293b;"
                            onfocus="this.style.borderColor='#4f46e5'; this.style.background='white'; this.style.boxShadow='0 0 0 3px rgba(79, 70, 229, 0.1)'"
                            onblur="this.style.borderColor='#e2e8f0'; this.style.background='#f8fafc'; this.style.boxShadow='none'"
                        />
                        <div id="chattie-email-error" style="color: #ef4444; font-size: 11px; margin-top: 6px; display: none; font-weight: 500;"></div>
                    </div>
                    <div style="display: flex; gap: 10px; align-items: center;">
                        <button id="chattie-step1-next" style="
                            flex: 1;
                            padding: 12px;
                            background: linear-gradient(135deg, #4f46e5 0%, #4338ca 100%);
                            color: white;
                            border: none;
                            border-radius: 8px;
                            font-size: 13px;
                            font-weight: 600;
                            cursor: pointer;
                            transition: transform 0.1s, box-shadow 0.2s;
                            box-shadow: 0 2px 4px rgba(79, 70, 229, 0.2);
                        "
                        onmouseover="this.style.boxShadow='0 4px 6px rgba(79, 70, 229, 0.3)'"
                        onmouseout="this.style.boxShadow='0 2px 4px rgba(79, 70, 229, 0.2)'"
                        >Continue</button>
                    </div>
                </div>

                <!-- STEP 2: NAME (Hidden Initially) -->
                <div id="chattie-step-2" style="display: none;">
                    <p style="margin: 0 0 12px 0; font-size: 13px; color: #475569; line-height: 1.5;">
                        What is your name?
                    </p>
                    <div style="margin-bottom: 16px;">
                        <input
                            type="text"
                            id="chattie-name-input"
                            placeholder="Your Name"
                            style="width: 100%; padding: 12px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 14px; outline: none; transition: all 0.2s; background: #f8fafc; color: #1e293b;"
                            onfocus="this.style.borderColor='#4f46e5'; this.style.background='white'; this.style.boxShadow='0 0 0 3px rgba(79, 70, 229, 0.1)'"
                            onblur="this.style.borderColor='#e2e8f0'; this.style.background='#f8fafc'; this.style.boxShadow='none'"
                        />
                        <div id="chattie-name-error" style="color: #ef4444; font-size: 11px; margin-top: 6px; display: none; font-weight: 500;"></div>
                    </div>
                    <button id="chattie-step2-submit" style="
                        width: 100%;
                        padding: 12px;
                        background: linear-gradient(135deg, #4f46e5 0%, #4338ca 100%);
                        color: white;
                        border: none;
                        border-radius: 8px;
                        font-size: 13px;
                        font-weight: 600;
                        cursor: pointer;
                        transition: transform 0.1s, box-shadow 0.2s;
                        box-shadow: 0 2px 4px rgba(79, 70, 229, 0.2);
                    "
                    onmouseover="this.style.boxShadow='0 4px 6px rgba(79, 70, 229, 0.3)'"
                    onmouseout="this.style.boxShadow='0 2px 4px rgba(79, 70, 229, 0.2)'"
                    >Start Chatting</button>
                </div>

            </div>
        `;

        chatBody.insertAdjacentHTML('beforeend', formHTML);
        chatBody.scrollTop = chatBody.scrollHeight;

        // Elements
        const container = document.getElementById('chattie-inline-form-container');
        const step1 = document.getElementById('chattie-step-1');
        const step2 = document.getElementById('chattie-step-2');

        const emailInput = document.getElementById('chattie-email-input');
        const emailError = document.getElementById('chattie-email-error');
        const btnNext = document.getElementById('chattie-step1-next');
        const btnSkip = document.getElementById('chattie-step1-skip');

        const nameInput = document.getElementById('chattie-name-input');
        const btnSubmit = document.getElementById('chattie-step2-submit');

        let collectedEmail = '';

        // Step 1 Logic
        function handleStep1() {
            const email = emailInput.value.trim().toLowerCase();
            if (isEmailMandatory && !email) {
                emailError.textContent = 'Email is required';
                emailError.style.display = 'block';
                return;
            }
            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                emailError.textContent = 'Please enter a valid email address';
                emailError.style.display = 'block';
                return;
            }

            // Check history before proceeding to name step
            // If history found -> page reloads automatically
            // If no history -> show name step
            if (email) {
                checkHistoryAndResume(email, null, (finalEmail) => {
                    // No history found — proceed to name step
                    collectedEmail = finalEmail;
                    step1.style.display = 'none';
                    step2.style.display = 'block';
                    nameInput.focus();
                });
            } else {
                collectedEmail = email;
                step1.style.display = 'none';
                step2.style.display = 'block';
                nameInput.focus();
            }
        }

        btnNext.addEventListener('click', () => handleStep1());
        emailInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleStep1(); });

        if (btnSkip) {
            btnSkip.addEventListener('click', () => {
                completeOnboarding(null, null, true);
            });
        }

        // Step 2 Logic
        function handleStep2() {
            const name = nameInput.value.trim();
            const nameError = document.getElementById('chattie-name-error');
            if (!name) {
                nameError.textContent = 'Name is required';
                nameError.style.display = 'block';
                return;
            } else {
                nameError.style.display = 'none';
            }
            completeOnboarding(collectedEmail, name, false);
        }

        btnSubmit.addEventListener('click', handleStep2);
        nameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleStep2(); });

        function completeOnboarding(email, name, skipped) {
            const finishOnboarding = () => {
                enableMessageInput();
                container.innerHTML = `
                    <div style="text-align: center; padding: 20px; color: #10b981; font-size: 14px; display: flex; flex-direction: column; align-items: center; gap: 8px;">
                        <div style="width: 32px; height: 32px; background: #ecfdf5; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #10b981;">
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                        </div>
                        <span style="font-weight: 500; color: #059669;">You're all set!</span>
                    </div>
                `;
                setTimeout(() => container.remove(), 2000);
            };

            if (!skipped) {
                // History check was already done in Step 1 — if we reach here it means no history found.
                // Just save the details and update metadata for this new chat.
                if (email) secureStorage.setItem(storageKeys.email, email);
                if (name) secureStorage.setItem(storageKeys.name, name);

                const payload = {
                    projectId,
                    chatId,
                    metadata: { email, name }
                };
                const token = encryptMessage(JSON.stringify(payload));
                socket.emit('update_metadata', { token });
                finishOnboarding();
            } else {
                secureStorage.setItem(storageKeys.email, "skipped");
                const payload = { projectId, chatId, metadata: { emailSkipped: true } };
                const token = encryptMessage(JSON.stringify(payload));
                socket.emit('update_metadata', { token });
                finishOnboarding();
            }
        }


        setTimeout(() => emailInput.focus(), 100);
    }

    // Re-enable message input after email submission
    function enableMessageInput() {
        const messageInput = document.querySelector('#chattie-input');
        const sendButton = document.querySelector('#chattie-send-btn');
        const inputWrapper = document.querySelector('.chattie-input-wrapper');

        if (messageInput) {
            messageInput.contentEditable = "true";
            messageInput.style.pointerEvents = "auto";
            messageInput.style.opacity = '1';
            messageInput.style.backgroundColor = 'transparent';
            messageInput.style.cursor = "text";
            messageInput.setAttribute("placeholder", "Type message here");
            if (messageInput.innerText === 'Please provide contact details to start chatting...') {
                messageInput.textContent = '';
            }
            messageInput.focus();
        }
        if (inputWrapper) {
            inputWrapper.style.cursor = "text";
        }
        if (sendButton) {
            sendButton.style.pointerEvents = "auto";
            sendButton.style.opacity = '1';
            sendButton.style.cursor = 'pointer';
        }
    }

    function disableMessageInputForResolution() {
        const inputEl = document.querySelector('#chattie-input');
        const sendBtn = document.querySelector('#chattie-send-btn');
        if (inputEl) {
            inputEl.contentEditable = 'true'; // Allow typing to reopen
            inputEl.style.opacity = '0.9';
            inputEl.style.cursor = 'text';
            inputEl.setAttribute('placeholder', 'Type message here');
            inputEl.innerHTML = '';
        }
        if (sendBtn) {
            sendBtn.style.pointerEvents = 'auto';
            sendBtn.style.opacity = '1';
        }
    }

    function sanitizeInput(html) {
        if (!html) return "";
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Remove dangerous tags entirely
        const dangerous = doc.querySelectorAll("script, iframe, object, embed, style, meta, link");
        dangerous.forEach(el => el.remove());

        // Strip attributes from all tags except 'href' on 'a'
        const all = doc.querySelectorAll("*");
        all.forEach(el => {
            if (el === doc.head || el === doc.body || el === doc.documentElement) return;
            const href = el.tagName === 'A' ? el.getAttribute('href') : null;
            while (el.attributes.length > 0) {
                el.removeAttribute(el.attributes[0].name);
            }
            if (href) {
                el.setAttribute('href', href);
                el.setAttribute('target', '_blank');
                el.setAttribute('rel', 'noopener noreferrer');
            }
        });

        // If content is empty after stripping (e.g. was just <style> with no text), return empty
        if (!doc.body.textContent.trim() && !doc.body.innerHTML.trim()) return "";

        return doc.body.innerHTML;
    }

    function chattieLinkify(text) {
        if (!text) return "";
        const combinedRegex = /(<a\b[^>]*>[\s\S]*?<\/a>)|(https?:\/\/[^\s<]+[^<.,:;"')\s])/gi;
        return text.replace(combinedRegex, function(match, group1, group2) {
            if (group1) return group1;
            return '<a href="' + group2 + '" target="_blank" rel="noopener noreferrer" style="color: #3b82f6; text-decoration: underline; font-weight: 500;">' + group2 + '</a>';
        });
    }

    // --- SHARED MESSAGE MENU (opens below the clicked bubble) ---
    function showChattieMessageMenu(items, align, anchorEl) {
        // Remove any existing menu
        const existingMenu = document.getElementById('chattie-msg-menu');
        if (existingMenu) existingMenu.remove();

        const win = document.querySelector('.chattie-window');
        if (!win) return;

        const menu = document.createElement('div');
        menu.id = 'chattie-msg-menu';
        menu.style.cssText = `
            position: absolute;
            background: white;
            border-radius: 14px;
            box-shadow: 0 8px 30px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
            z-index: 99999;
            min-width: 160px;
            overflow: hidden;
            border: 1px solid #e8edf2;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 4px 0;
            opacity: 0;
            transform: translateY(-6px) scale(0.97);
            transition: opacity 0.15s ease, transform 0.15s ease;
        `;

        items.forEach((item, idx) => {
            const el = document.createElement('div');
            el.style.cssText = `
                padding: 11px 16px;
                font-size: 14px;
                font-weight: 400;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 12px;
                color: #334155;
                transition: background 0.1s;
                white-space: nowrap;
                ${idx > 0 ? 'border-top: 1px solid #f1f5f9;' : ''}
            `;
            el.innerHTML = `${item.icon}<span>${item.label}</span>`;
            el.onmouseenter = () => el.style.backgroundColor = '#f1f5f9';
            el.onmouseleave = () => el.style.backgroundColor = 'transparent';
            el.onclick = (e) => {
                e.stopPropagation();
                menu.remove();
                item.action();
            };
            menu.appendChild(el);
        });

        // Append first so getBoundingClientRect gives correct size
        win.appendChild(menu);

        // Position below the anchor bubble
        if (anchorEl) {
            const winRect = win.getBoundingClientRect();
            const bubbleRect = anchorEl.getBoundingClientRect();
            let topOffset = bubbleRect.bottom - winRect.top + 4;
            // If dropdown would overflow below the widget, flip it above the bubble
            if (topOffset + menu.offsetHeight > win.offsetHeight - 10) {
                topOffset = bubbleRect.top - winRect.top - menu.offsetHeight - 4;
            }
            menu.style.top = Math.max(4, topOffset) + 'px';
            if (align === 'right') {
                const rightOffset = winRect.right - bubbleRect.right;
                menu.style.right = Math.max(4, rightOffset) + 'px';
            } else {
                const leftOffset = bubbleRect.left - winRect.left;
                menu.style.left = Math.max(4, leftOffset) + 'px';
            }
        }

        // Animate in smoothly
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                menu.style.opacity = '1';
                menu.style.transform = 'translateY(0) scale(1)';
            });
        });

        setTimeout(() => {
            document.addEventListener('click', () => {
                const m = document.getElementById('chattie-msg-menu');
                if (m) m.remove();
            }, { once: true });
        }, 0);
    }

    // --- REPLY STATE ---
    let widgetReplyingToId = null;

    function showWidgetReplyBar(msgId, msgText) {
        widgetReplyingToId = msgId;

        // Remove existing bar if any
        clearWidgetReplyBar(false);

        const inputWrapper = document.querySelector('.chattie-input-wrapper');
        if (!inputWrapper) return;

        const plainText = typeof msgText === 'string' ? msgText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';

        const bar = document.createElement('div');
        bar.id = 'chattie-reply-bar';
        bar.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 6px 12px;
            background: #f1f5f9;
            border-left: 3px solid #4f46e5;
            border-radius: 6px;
            margin-bottom: 6px;
            font-size: 12px;
            color: #475569;
        `;

        const textDiv = document.createElement('div');
        textDiv.style.cssText = 'flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;';
        textDiv.innerHTML = `<span style="font-weight:600;color:#334155;">Replying to: </span><span>${plainText || 'Message'}</span>`;

        const closeBtn = document.createElement('div');
        closeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        closeBtn.style.cssText = 'cursor: pointer; flex-shrink: 0; color: #94a3b8; display: flex; align-items: center;';
        closeBtn.onmouseenter = () => closeBtn.style.color = '#ef4444';
        closeBtn.onmouseleave = () => closeBtn.style.color = '#94a3b8';
        closeBtn.onclick = () => clearWidgetReplyBar(true);

        bar.appendChild(textDiv);
        bar.appendChild(closeBtn);
        inputWrapper.insertBefore(bar, inputWrapper.firstChild);
    }

    function clearWidgetReplyBar(resetId = true) {
        if (resetId) widgetReplyingToId = null;
        const existing = document.getElementById('chattie-reply-bar');
        if (existing) existing.remove();
    }

    function sendMessage(messageText) {
        // Safety net: block if rating is still pending (guards all call sites)
        if (isRatingPending) return;
        if (!socket || !socket.connected) {
            console.error('Socket not connected');
            return;
        }

        if (!messageText.trim()) return;

        // Sanitize input to prevent style injection
        const cleanMessage = sanitizeInput(messageText);
        if (!cleanMessage) return;

        const payload = {
            projectId,
            chatId,
            senderType: 'student',
            senderId: userId,
            messageType: 'text',
            message: cleanMessage.trim(),
            ...(widgetReplyingToId ? { replyTo: widgetReplyingToId } : {})
        };

        const token = encryptMessage(JSON.stringify(payload));
        socket.emit('send_message', { token });

        // Clear reply bar after sending
        clearWidgetReplyBar(true);

        // Play sent sound
        const soundUrl = `${API_BASE}/sounds/sent.mp3`;
        try {
            const audio = new Audio(soundUrl);
            audio.play()
                .then(() => { })
                .catch((err) => console.error('❌ Error playing sound:', err));
        } catch (e) {
            console.error('❌ Audio creation error:', e);
        }

        // We do NOT add to UI immediately to avoid ID issues.
        // We wait for the 'new_message' event which broadcasts to sender too.

        // Increment message count
        studentMessageCount++;
    }

    const TICK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    const DOUBLE_TICK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/></svg>';

    function getTickIcon(status) {
        if (status === 'seen') return DOUBLE_TICK_ICON;
        if (status === 'delivered') return DOUBLE_TICK_ICON;
        return TICK_ICON;
    }

    function showImagePreview(url) {
        const modal = document.getElementById('chattie-img-modal');
        const modalImg = document.getElementById('chattie-img-modal-content');
        if (modal && modalImg) {
            modalImg.src = url;
            modal.style.display = 'flex';
            // Trigger reflow for transition
            modal.offsetHeight;
            modal.classList.add('active');
        }
    }

    let isRatingPending = false;

    function disableMessagingForRating() {
        const input = document.querySelector('.chattie-input-field-modern') || document.querySelector('#chattie-input');
        const sendBtn = document.querySelector('#chattie-send-btn');
        const attachBtn = document.querySelector('#chattie-attach-btn');
        isRatingPending = true;

        if (input) {
            input.contentEditable = "false";
            input.setAttribute('placeholder', "Please rate our support team to continue...");
            input.innerText = "";
            input.style.opacity = "0.7";
            input.style.cursor = "not-allowed";
        }
        if (sendBtn) {
            sendBtn.style.opacity = "0.5";
            sendBtn.style.pointerEvents = "none";
        }
        if (attachBtn) {
            attachBtn.style.opacity = "0.5";
            attachBtn.style.pointerEvents = "none";
        }
    }

    function enableMessagingAfterRating() {
        const input = document.querySelector('.chattie-input-field-modern') || document.querySelector('#chattie-input');
        const sendBtn = document.querySelector('#chattie-send-btn');
        const attachBtn = document.querySelector('#chattie-attach-btn');
        isRatingPending = false;

        if (input) {
            input.contentEditable = "true";
            input.setAttribute('placeholder', "Type message here");
            input.style.opacity = "1";
            input.style.cursor = "text";
        }
        if (sendBtn) {
            sendBtn.style.opacity = "1";
            sendBtn.style.pointerEvents = "auto";
        }
        if (attachBtn) {
            attachBtn.style.opacity = "1";
            attachBtn.style.pointerEvents = "auto";
        }
        isRatingPending = false;
    }

    let lastRenderedDate = null;

    function addMessageToUI(text, sender, timestampStr = null, type = 'text', fileUrl = null, status = 'sent', messageId = null, skipScroll = false, replyTo = null, reactions = [], showRating = false, isDeleted = false) {
        const chatBody = document.querySelector("#chattie-body");
        if (!chatBody) return;

        // --- DEFENSIVE GUARD ---
        // If this is a system message about resolution, NEVER show the rating UI here.
        // The rating UI should ONLY be triggered by an explicit "Support has requested a rating" message.
        if (sender === 'system' && text && text.toLowerCase().includes('resolved')) {
            showRating = false;
        }

        // Prevent duplicates
        if (messageId && document.querySelector(`.chattie-message-group[data-id="${messageId}"]`)) return;

        const msgDateObj = timestampStr ? new Date(timestampStr) : new Date();
        const msgTimestamp = msgDateObj.getTime();
        const msgDateStr = msgDateObj.toDateString();

        const existingMessages = Array.from(chatBody.querySelectorAll('.chattie-message-group[data-timestamp]'));
        let insertBeforeEl = null;

        for (const el of existingMessages) {
            const elTimestamp = parseInt(el.getAttribute('data-timestamp'));
            if (elTimestamp > msgTimestamp) {
                insertBeforeEl = el;
                break;
            }
        }

        if (lastRenderedDate !== msgDateStr) {
            lastRenderedDate = msgDateStr;

            const today = new Date();
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);

            let dateText = "";
            if (msgDateStr === today.toDateString()) {
                dateText = "Today";
            } else if (msgDateStr === yesterday.toDateString()) {
                dateText = "Yesterday";
            } else {
                dateText = msgDateObj.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
            }

            const dateDivider = document.createElement("div");
            dateDivider.style.cssText = "display: flex; justify-content: center; margin: 16px 0; width: 100%; clear: both;";

            const dateSpan = document.createElement("div");
            dateSpan.style.cssText = "background: #f1f5f9; color: #64748b; font-size: 12px; padding: 4px 12px; border-radius: 9999px; font-weight: 500;";
            dateSpan.innerText = dateText;

            dateDivider.appendChild(dateSpan);

            const emailForm = document.getElementById('chattie-inline-form-container');
            const typingIndicator = document.getElementById('chattie-typing-indicator');

            if (emailForm && chatBody.contains(emailForm)) {
                chatBody.insertBefore(dateDivider, emailForm);
            } else if (typingIndicator && chatBody.contains(typingIndicator)) {
                chatBody.insertBefore(dateDivider, typingIndicator);
            } else {
                chatBody.appendChild(dateDivider);
            }
        }

        // (Removed strict text clearing for images to allow captions)
        if (messageId) {
            allMessagesMap.set(messageId, { text, sender, type, fileUrl });
        }

        const messageGroup = document.createElement("div");
        messageGroup.className = "chattie-message-group";
        if (sender === 'student') messageGroup.classList.add('student');
        if (messageId) {
            messageGroup.setAttribute('data-id', messageId);
            messageGroup.setAttribute('data-status', status || 'sent');
        }
        messageGroup.setAttribute('data-timestamp', msgTimestamp.toString());
        messageGroup.style.width = '100%'; // Ensure full width for alignment (v10)
        messageGroup.style.alignItems = sender === 'student' ? 'flex-end' : (sender === 'system' ? 'center' : 'flex-start');

        if (sender === 'system') {
            // Already set to 100% above
            const sysMsg = document.createElement("div");
            sysMsg.className = "chattie-system-message";
            sysMsg.style.cssText = "background: #f1f5f9; color: #64748b; font-size: 11px; padding: 4px 12px; border-radius: 9999px; text-align: center; margin: 8px 0;";
            sysMsg.textContent = text;
            if (text !== "Support has requested a rating" && !text.startsWith("Rating from student:")) {
                messageGroup.appendChild(sysMsg);
            }

            // MANDATORY RATING BLOCK — only if not deleted
            if (showRating && !isDeleted) {
                disableMessagingForRating();
            }

            // --- VISITOR RATING INJECTION ---
            if (showRating && !isDeleted) {
                const ratingContainer = document.createElement("div");
                ratingContainer.id = `rating-block-${messageId}`;
                ratingContainer.style.cssText = `
                    background: white;
                    border: 1px solid #e2e8f0;
                    border-radius: 12px;
                    padding: 16px;
                    margin: 8px auto;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 12px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.05);
                    width: 90%;
                    max-width: 280px;
                    animation: chattie-slide-in 0.3s ease-out;
                `;

                const ratingTitle = document.createElement("div");
                ratingTitle.style.cssText = "font-size: 16px; font-weight: 600; color: #334155; text-align: center; margin-bottom: 4px;";
                ratingTitle.innerText = "Rate our support team";
                ratingContainer.appendChild(ratingTitle);

                const starsWrapper = document.createElement("div");
                starsWrapper.style.cssText = "display: flex; gap: 8px; cursor: pointer; justify-content: center; width: 100%;";

                const textLabel = document.createElement("div");
                textLabel.style.cssText = "font-size: 11px; color: #64748b; min-height: 0; margin-top: 0;";

                // === NEW: Submit Button ===
                const submitBtn = document.createElement("button");
                submitBtn.innerText = "Submit";
                submitBtn.style.cssText = `
                    background: #a5a2f3;
                    color: white;
                    border: none;
                    border-radius: 10px;
                    padding: 8px 24px;
                    font-size: 14px;
                    font-weight: 600;
                    cursor: pointer;
                    margin-top: 4px;
                    transition: all 0.2s;
                    opacity: 0.5;
                    pointer-events: none;
                    box-shadow: 0 2px 4px rgba(165, 162, 243, 0.3);
                `;
                submitBtn.onmouseenter = () => { if (submitBtn.style.pointerEvents !== 'none') submitBtn.style.background = "#9491e6"; };
                submitBtn.onmouseleave = () => { if (submitBtn.style.pointerEvents !== 'none') submitBtn.style.background = "#a5a2f3"; };

                let currentRating = 0;
                let isSubmitted = false;
                const starElements = [];

                const emojiMap = {
                    1: "😡",
                    2: "😠",
                    3: "😐",
                    4: "😊",
                    5: "😍",
                };

                for (let i = 1; i <= 5; i++) {
                    const star = document.createElement("div");
                    star.style.cssText = "font-size: 28px; cursor: pointer; transition: all 0.2s; opacity: 0.5; filter: grayscale(50%);";
                    star.innerText = emojiMap[i];

                    star.addEventListener('mouseenter', () => {
                        if (isSubmitted) return;
                        updateStars(i, true);
                    });

                    star.addEventListener('mouseleave', () => {
                        if (isSubmitted) return;
                        updateStars(currentRating, false);
                    });

                    star.addEventListener('click', () => {
                        if (isSubmitted) return;
                        currentRating = i;
                        updateStars(currentRating, false);

                        // Enable submit button
                        submitBtn.style.opacity = '1';
                        submitBtn.style.pointerEvents = 'auto';
                    });

                    starElements.push(star);
                    starsWrapper.appendChild(star);
                }

                // === Submit Action ===
                submitBtn.addEventListener('click', async () => {
                    if (isSubmitted || currentRating === 0) return;

                    isSubmitted = true;
                    starsWrapper.style.opacity = '0.7';
                    starsWrapper.style.cursor = 'default';
                    submitBtn.style.opacity = '0.5';
                    submitBtn.style.pointerEvents = 'none';
                    submitBtn.innerText = "Submitting...";

                    try {
                        const token = secureStorage.getItem(storageKeys.token);
                        const headers = { 'Content-Type': 'application/json' };
                        if (token) headers["Authorization"] = `Bearer ${token}`;

                        const response = await fetch(`${API_BASE}/api/messages/${projectId}/${chatId}/rating`, {
                            method: 'POST',
                            headers: headers,
                            body: JSON.stringify({ rating: currentRating })
                        });

                        const res = await response.json();

                        if (res.success) {
                            // Successfully rated!
                            enableMessagingAfterRating();

                            ratingTitle.innerText = "Thank you for rating!";
                            ratingTitle.style.color = "#10b981";
                            textLabel.innerText = "";
                            submitBtn.style.display = "none";

                            // Remove block after 2 seconds
                            setTimeout(() => {
                                ratingContainer.style.opacity = "0";
                                ratingContainer.style.transform = "scale(0.95)";
                                ratingContainer.style.transition = "all 0.3s ease";
                                setTimeout(() => {
                                    ratingContainer.remove();
                                }, 300);
                            }, 2000);

                        } else {
                            ratingTitle.innerText = res.message || "Failed to submit.";
                            ratingTitle.style.color = "#ef4444";
                            submitBtn.innerText = "Submit";
                            submitBtn.style.opacity = '1';
                            submitBtn.style.pointerEvents = 'auto';
                            isSubmitted = false;
                        }
                    } catch (err) {
                        console.error("Failed rating submit", err);
                        ratingTitle.innerText = "Error saving rating.";
                        submitBtn.innerText = "Submit";
                        submitBtn.style.opacity = '1';
                        submitBtn.style.pointerEvents = 'auto';
                        isSubmitted = false;
                    }
                });

                function updateStars(val, isHover) {
                    starElements.forEach((el, idx) => {
                        if (idx + 1 === val) {
                            el.style.opacity = "1";
                            el.style.filter = "grayscale(0%)";
                            el.style.transform = isHover ? "scale(1.2)" : "scale(1.15)";
                        } else {
                            // If something is selected, highlight only that.
                            // If hover, highlight hover and below? No, emojis are discrete.
                            // User image shows only the selected/hovered one is prominent.
                            if (val > 0 && idx + 1 !== val) {
                                el.style.opacity = "0.3";
                                el.style.filter = "grayscale(80%)";
                                el.style.transform = "scale(0.9)";
                            } else {
                                el.style.opacity = "0.5";
                                el.style.filter = "grayscale(50%)";
                                el.style.transform = "scale(1)";
                            }
                        }
                    });
                }

                ratingContainer.appendChild(starsWrapper);
                ratingContainer.appendChild(textLabel);
                ratingContainer.appendChild(submitBtn);
                messageGroup.appendChild(ratingContainer);
            }

            const emailForm = document.getElementById('chattie-inline-form-container');
            const typingIndicator = document.getElementById('chattie-typing-indicator');

            if (emailForm && chatBody.contains(emailForm)) {
                chatBody.insertBefore(messageGroup, emailForm);
            } else if (typingIndicator && chatBody.contains(typingIndicator)) {
                chatBody.insertBefore(messageGroup, typingIndicator);
            } else {
                chatBody.appendChild(messageGroup);
            }

            if (!skipScroll) {
                chatBody.scrollTop = chatBody.scrollHeight;
            }
            return;
        }

        const bubbleWrapper = document.createElement("div");
        bubbleWrapper.style.position = "relative";
        bubbleWrapper.style.display = "flex";
        bubbleWrapper.style.flexDirection = "column";

        const bubble = document.createElement("div");
        bubble.className = "chattie-bubble";

        const theme = projectConfig?.widgetConfig?.theme || 'modern';

        if (sender === 'student') {
            const isMinimal = theme === 'minimal';
            const primaryColor = projectConfig?.widgetConfig?.primaryColor || '#4f46e5';

            // Container: Bubble + Avatar
            const contentRow = document.createElement("div");
            contentRow.style.cssText = `
                display: flex;
                align-items: flex-end;
                gap: 8px;
                max-width: 95%;
                justify-content: flex-end;
                position: relative;
            `;

            bubble.style.maxWidth = "100%";
            bubble.style.position = "relative";

            // User Avatar
            const avatar = document.createElement("div");
            avatar.style.width = "28px";
            avatar.style.height = "28px";
            avatar.style.borderRadius = "50%";
            avatar.style.flexShrink = "0";
            avatar.style.display = "flex";
            avatar.style.alignItems = "center";
            avatar.style.justifyContent = "center";
            avatar.style.backgroundColor = isMinimal ? "#f8fafc" : "#eff6ff";

            let iconColor = isMinimal ? '#1e293b' : primaryColor;
            avatar.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="${iconColor}">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>`;

            // Bubble style
            bubble.style.cssText = `
                background-color: ${isMinimal ? '#1e293b' : primaryColor};
                color: white;
                border-radius: 16px;
                border-bottom-right-radius: 4px;
                padding: 8px 12px;
                font-size: 14px;
                line-height: 1.4;
                position: relative;
                width: fit-content;
                max-width: 85%;
                min-width: fit-content;
                flex-shrink: 1;
                word-break: break-word;
                overflow-wrap: break-word;
                white-space: pre-wrap;
                box-sizing: border-box;
                box-shadow: 0 1px 2px rgba(0,0,0,0.1);
            `;

            // --- MORE OPTIONS BUTTON (Left Side) ---
            if (messageId && type === 'text') {
                const moreBtn = document.createElement("div");
                moreBtn.className = "chattie-more-options";
                moreBtn.style.cssText = `
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    opacity: 0;
                    transition: opacity 0.2s;
                    color: #94a3b8;
                    width: 24px;
                    height: 24px;
                    border-radius: 50%;
                    flex-shrink: 0;
                    align-self: center;
                `;
                moreBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>`;

                bubble.addEventListener('mouseenter', () => moreBtn.style.opacity = '1');
                bubble.addEventListener('mouseleave', () => moreBtn.style.opacity = '0');
                moreBtn.addEventListener('mouseenter', () => {
                    moreBtn.style.opacity = '1';
                    moreBtn.style.backgroundColor = 'rgba(0,0,0,0.05)';
                });
                moreBtn.addEventListener('mouseleave', () => {
                    moreBtn.style.backgroundColor = 'transparent';
                });

                moreBtn.addEventListener('click', (e) => {
                    e.stopPropagation();

                    const menuItems = [];

                    // ── 15-MINUTE EDIT WINDOW CHECK ──
                    const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
                    const msgTime = timestampStr ? new Date(timestampStr).getTime() : Date.now();
                    const isEditable = (Date.now() - msgTime) <= EDIT_WINDOW_MS;

                    if (isEditable) {
                        menuItems.push({
                            icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#64748b"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`,
                            label: 'Edit',
                            action: () => {
                                const inputField = document.getElementById('chattie-input') || document.querySelector('.chattie-input-field-modern');
                                if (inputField) {
                                    window.chattieEditingMessageId = messageId;
                                    inputField.innerHTML = sanitizeInput(text);
                                    inputField.focus();
                                    try {
                                        const range = document.createRange();
                                        const sel = window.getSelection();
                                        range.selectNodeContents(inputField);
                                        range.collapse(false);
                                        sel.removeAllRanges();
                                        sel.addRange(range);
                                    } catch (err) { }
                                }
                            }
                        });
                    }

                    menuItems.push({
                        icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#64748b"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>`,
                        label: 'Reply',
                        action: () => {
                            showWidgetReplyBar(messageId, text);
                            const inputField = document.getElementById('chattie-input') || document.querySelector('.chattie-input-field-modern');
                            if (inputField) inputField.focus();
                        }
                    });

                    showChattieMessageMenu(menuItems, 'right', bubble);
                });

                contentRow.appendChild(moreBtn);
            }

            bubbleWrapper.appendChild(bubble);
            contentRow.appendChild(bubbleWrapper);
            contentRow.appendChild(avatar);
            messageGroup.appendChild(contentRow);
        } else {
            // Support Message: Always Neutral / "Normal"
            bubble.className += " chattie-bubble-support";
            const isMinimal = theme === 'minimal';
            // Use supportLogoUrl if available, otherwise fallback to standard logoUrl
            const supportLogo = projectConfig?.widgetConfig?.supportLogoUrl || projectConfig?.widgetConfig?.logoUrl;

            // Container for Avatar + Bubble
            const contentRow = document.createElement("div");
            contentRow.style.display = "flex";
            contentRow.style.alignItems = "flex-end"; // Align avatar to bottom of bubble
            contentRow.style.gap = "4px";
            contentRow.style.maxWidth = "95%";

            // Override inner bubble max-width
            bubble.style.maxWidth = "100%";

            // Support Avatar
            if (supportLogo) {
                const avatar = document.createElement("img");
                avatar.src = supportLogo;
                avatar.style.width = "28px";
                avatar.style.height = "28px";
                avatar.style.borderRadius = "50%"; // Circular
                avatar.style.objectFit = "cover";
                avatar.style.flexShrink = "0";
                contentRow.appendChild(avatar);
            } else {
                // Fallback Avatar if no logo
                const avatarPlaceholder = document.createElement("div");
                avatarPlaceholder.style.width = "28px";
                avatarPlaceholder.style.height = "28px";
                avatarPlaceholder.style.borderRadius = "50%";
                avatarPlaceholder.style.backgroundColor = "#cbd5e1";
                avatarPlaceholder.style.flexShrink = "0";
                avatarPlaceholder.style.display = "flex";
                avatarPlaceholder.style.alignItems = "center";
                avatarPlaceholder.style.justifyContent = "center";
                avatarPlaceholder.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
                contentRow.appendChild(avatarPlaceholder);
            }

            // Update bubble style to make position:relative and add right padding for chevron
            if (isMinimal) {
                bubble.style.cssText = `
                    background-color: #ffffff;
                    color: #1e293b;
                    border: 1px solid #e2e8f0;
                    border-radius: 16px;
                    border-bottom-left-radius: 4px;
                    padding: 8px 12px;
                    font-size: 14px;
                    line-height: 1.4;
                    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
                    position: relative;
                    width: fit-content;
                    max-width: 85%;
                    min-width: fit-content;
                    flex-shrink: 1;
                    word-break: break-word;
                    overflow-wrap: break-word;
                    white-space: pre-wrap;
                    box-sizing: border-box;
                `;
            } else {
                bubble.style.cssText = `
                    background-color: #f1f5f9;
                    color: #1e293b;
                    border-radius: 16px;
                    border-bottom-left-radius: 4px;
                    padding: 8px 12px;
                    font-size: 14px;
                    line-height: 1.4;
                    position: relative;
                    width: fit-content;
                    max-width: 85%;
                    min-width: fit-content;
                    flex-shrink: 1;
                    word-break: break-word;
                    overflow-wrap: break-word;
                    white-space: pre-wrap;
                    box-sizing: border-box;
                    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
                `;
            }

            bubbleWrapper.appendChild(bubble);
            contentRow.appendChild(bubbleWrapper);

            // --- MORE OPTIONS BUTTON (Right Side) ---
            if (messageId) {
                const suppMoreBtn = document.createElement("div");
                suppMoreBtn.style.cssText = `
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    opacity: 0;
                    transition: opacity 0.2s;
                    color: #94a3b8;
                    width: 24px;
                    height: 24px;
                    border-radius: 50%;
                    flex-shrink: 0;
                    align-self: center;
                `;
                suppMoreBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>`;

                bubble.addEventListener('mouseenter', () => suppMoreBtn.style.opacity = '1');
                bubble.addEventListener('mouseleave', () => suppMoreBtn.style.opacity = '0');
                suppMoreBtn.addEventListener('mouseenter', () => {
                    suppMoreBtn.style.opacity = '1';
                    suppMoreBtn.style.backgroundColor = 'rgba(0,0,0,0.05)';
                });
                suppMoreBtn.addEventListener('mouseleave', () => {
                    suppMoreBtn.style.backgroundColor = 'transparent';
                });

                suppMoreBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showChattieMessageMenu([
                        {
                            icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#64748b"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>`,
                            label: 'Reply',
                            action: () => {
                                showWidgetReplyBar(messageId, text);
                                const inputField = document.getElementById('chattie-input') || document.querySelector('.chattie-input-field-modern');
                                if (inputField) inputField.focus();
                            }
                        }
                    ], 'left', bubble);
                });

                contentRow.appendChild(suppMoreBtn);
            }
            messageGroup.appendChild(contentRow);
        }

        // --- Reply Preview ---
        let replyParent = null;
        let replyParentId = null;

        if (replyTo) {
            if (typeof replyTo === 'object' && replyTo._id) {
                // It's a populated object from backend
                replyParentId = replyTo._id;
                replyParent = {
                    sender: replyTo.senderType,
                    type: replyTo.messageType || 'text',
                    text: replyTo.message,
                    fileUrl: replyTo.fileUrl
                };
            } else if (typeof replyTo === 'string') {
                replyParentId = replyTo;
                if (allMessagesMap.has(replyTo)) {
                    replyParent = allMessagesMap.get(replyTo);
                }
            }
        }

        if (replyParent) {
            const replyPreview = document.createElement("div");
            const isStudent = sender === 'student';
            replyPreview.style.cssText = `
                background: ${isStudent ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.05)'};
                border-left: 3px solid ${replyParent.sender === 'student' ? '#fbbf24' : '#3b82f6'};
                padding: 4px 8px;
                border-radius: 4px;
                margin-bottom: 4px;
                font-size: 12px;
                display: flex;
                gap: 8px;
                align-items: center;
                cursor: pointer;
                max-width: 100%;
                overflow: hidden;
            `;
            replyPreview.onclick = (e) => {
                e.stopPropagation();
                if (replyParentId) {
                    const el = document.querySelector(`.chattie-message-group[data-id="${replyParentId}"]`);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            };

            if (replyParent.type === 'image' && replyParent.fileUrl) {
                const thumb = document.createElement("img");
                thumb.src = replyParent.fileUrl;
                thumb.style.cssText = "width: 32px; height: 32px; object-fit: cover; border-radius: 2px; flex-shrink: 0; background: white;";
                replyPreview.appendChild(thumb);
            }

            const textContainer = document.createElement("div");
            textContainer.style.cssText = "overflow: hidden; flex: 1; min-width: 0;";

            const parentName = document.createElement("div");
            parentName.style.cssText = `font-weight: bold; color: ${replyParent.sender === 'student' ? '#d97706' : '#2563eb'}; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`;
            parentName.innerText = replyParent.sender === 'student' ? 'You' : 'Support';
            textContainer.appendChild(parentName);

            const parentTextEl = document.createElement("div");
            parentTextEl.style.cssText = "white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.9; display: flex; align-items: center; gap: 4px;";

            let typeIcon = '';
            if (replyParent.type === 'image') {
                typeIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.7;"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>';
            } else if (replyParent.type === 'file') {
                typeIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.7;"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.51a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
            }

            const rawReplyText = replyParent.type === 'image' ? (replyParent.text || 'Image') : (replyParent.type === 'file' ? (replyParent.text || 'Attachment') : (replyParent.text || 'Message'));
            const plainReplyText = typeof rawReplyText === 'string' ? rawReplyText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : rawReplyText;
            parentTextEl.innerHTML = `${typeIcon} <span>${plainReplyText || 'Message'}</span>`;
            textContainer.appendChild(parentTextEl);

            replyPreview.appendChild(textContainer);
            bubble.appendChild(replyPreview);
        }

        if (type === 'image' && fileUrl) {
            const img = document.createElement('img');
            img.src = fileUrl;
            img.style.maxWidth = '100%';
            img.style.maxHeight = '250px';
            img.style.objectFit = 'contain';
            img.style.borderRadius = '8px';
            img.style.cursor = 'pointer';
            img.style.display = 'block';
            // Ensure transparent images look correct by providing a white background
            img.style.backgroundColor = '#ffffff';
            img.onclick = () => showImagePreview(fileUrl);
            bubble.appendChild(img);

            // Show caption below image if text exists
            // Using logic to treat it as a caption-message combo
            if (text && text !== 'File' && text.trim() !== '') {
                const caption = document.createElement('div');
                caption.style.marginTop = '8px';
                caption.style.fontSize = '14px'; // Normal text size
                caption.style.opacity = '1';     // Full opacity
                caption.style.lineHeight = '1.4';
                caption.style.wordBreak = 'break-word';
                caption.style.color = 'inherit'; // Inherit bubble text color
                caption.innerHTML = chattieLinkify(sanitizeInput(text));        // Use innerHTML for formatting
                bubble.appendChild(caption);
            }
        } else if (type === 'file' && fileUrl) {
            // File attachment
            const link = document.createElement('a');
            link.href = fileUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.style.display = 'flex';
            link.style.alignItems = 'center';
            link.style.gap = '8px';
            link.style.textDecoration = 'none';
            link.style.color = 'inherit';
            link.style.marginTop = '4px';

            const iconDiv = document.createElement('div');
            iconDiv.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>';

            const fileNameSpan = document.createElement('span');
            fileNameSpan.textContent = text || 'Download File';
            fileNameSpan.style.textDecoration = 'underline';

            link.appendChild(iconDiv);
            link.appendChild(fileNameSpan);
            bubble.appendChild(link);
        } else if (text && text.trim() !== '') {
            // appendChild (not insertBefore) so replyPreview stays on top, text goes below it
            const textNode = document.createElement('div');
            textNode.className = 'chattie-bubble-text';
            textNode.innerHTML = chattieLinkify(sanitizeInput(text));
            bubble.appendChild(textNode);
        }

        // --- REACTIONS RENDER ---
        if (reactions && reactions.length > 0) {
            const reactionContainer = document.createElement('div');
            reactionContainer.className = 'chattie-reaction-container';
            reactionContainer.style.cssText = `
                display: flex;
                flex-direction: row;
                flex-wrap: wrap;
                gap: 2px;
                margin-top: -8px;
                margin-bottom: 2px;
                z-index: 10;
                align-self: ${sender === 'student' ? 'flex-end' : 'flex-start'};
                position: relative;
            `;

            // Group by emoji
            const grouped = {};
            reactions.forEach(r => {
                grouped[r.emoji] = (grouped[r.emoji] || 0) + 1;
            });

            Object.entries(grouped).forEach(([emoji, count]) => {
                const badge = document.createElement('div');
                badge.style.cssText = `
                    background: #ffffff;
                    border: 1px solid #e2e8f0;
                    border-radius: 12px;
                    padding: 2px 6px;
                    font-size: 11px;
                    color: #475569;
                    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
                    display: flex;
                    align-items: center;
                    gap: 4px;
                `;
                badge.innerHTML = `<span>${emoji}</span><span>${count}</span>`;
                reactionContainer.appendChild(badge);
            });

            bubbleWrapper.appendChild(reactionContainer);
        }

        // STATUS & TIMESTAMP CONTAINER
        const metaContainer = document.createElement("div");
        metaContainer.style.display = 'flex';
        metaContainer.style.alignItems = 'center';
        metaContainer.style.gap = '4px';
        metaContainer.style.marginTop = '0px';
        metaContainer.style.marginRight = '2px';

        const timestamp = document.createElement("div");
        const timeString = timestampStr
            ? new Date(timestampStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        timestamp.textContent = timeString;
        timestamp.style.fontSize = '11px';
        timestamp.style.color = '#94a3b8';
        metaContainer.appendChild(timestamp);

        if (sender === 'student') {
            const tickSpan = document.createElement('span');
            tickSpan.className = 'chattie-tick-container';
            tickSpan.innerHTML = getTickIcon(status);
            tickSpan.style.display = 'flex';
            tickSpan.style.alignItems = 'center';

            if (status === 'seen') {
                tickSpan.style.color = '#34B7F1'; // Vibrant Blue (WhatsApp style)
            } else {
                tickSpan.style.color = '#94a3b8'; // gray
            }

            metaContainer.appendChild(tickSpan);
            // Add right margin to offset the student avatar
            metaContainer.style.marginRight = '32px';
        } else {
            // Add left margin to offset the support avatar
            metaContainer.style.marginLeft = '36px';
        }

        messageGroup.appendChild(metaContainer);

        // Check if the email prompt form or typing indicator or insertBeforeEl exists
        const emailForm = document.getElementById('chattie-inline-form-container');
        const typingIndicator = document.getElementById('chattie-typing-indicator');

        if (insertBeforeEl) {
            chatBody.insertBefore(messageGroup, insertBeforeEl);
        } else if (emailForm && chatBody.contains(emailForm)) {
            chatBody.insertBefore(messageGroup, emailForm);
        } else if (typingIndicator && chatBody.contains(typingIndicator)) {
            chatBody.insertBefore(messageGroup, typingIndicator);
        } else {
            chatBody.appendChild(messageGroup);
        }

        if (!skipScroll) {
            chatBody.scrollTop = chatBody.scrollHeight;
        }
    }

    function initChattie(config) {
        // Provide default values for config
        let {
            theme = 'modern',
            primaryColor = '#4f46e5',
            headerTextColor = '#ffffff',
            productNameSize = '12',
            productNameX = '0',
            productNameY = '0',
            logoUrl = '',
            companyName = 'Support Team',
            position = 'bottom-right',
            welcomeMessage = 'Hello! How can we help you today?',
            logoParams,
            headerText = 'Talk with Support! 👋'
        } = config || {};

        // Force Minimal Theme Colors against user selection
        if (theme === 'minimal') {
            primaryColor = '#1e293b'; // Slate-800
            headerTextColor = '#1e293b';
        }

        const logoX = logoParams?.x || '0';
        const logoY = logoParams?.y || '0';
        const logoSize = logoParams?.size || '64';

        // --- STYLES ---
        const style = document.createElement("style");
        style.innerHTML = `
            #chattie-root {
                position: fixed;
                z-index: 9999;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                ${(position || 'bottom-right').includes('left') ? 'left: 20px; right: auto;' : 'right: 20px; left: auto;'}
                ${(position || 'bottom-right').includes('top') ? 'top: 20px; bottom: auto;' : 'bottom: 20px; top: auto;'}
                display: flex;
                flex-direction: ${(position || 'bottom-right').includes('top') ? 'column-reverse' : 'column'};
                align-items: ${(position || 'bottom-right').includes('left') ? 'flex-start' : 'flex-end'};
                gap: 16px;
            }
            
            /* Custom Scrollbar for Widget */
            #chattie-root *::-webkit-scrollbar {
                width: 5px;
            }
            #chattie-root *::-webkit-scrollbar-thumb {
                background-color: #cbd5e1;
                border-radius: 4px;
            }
            #chattie-root *::-webkit-scrollbar-track {
                background: transparent;
            }
            
            /* Toggle Button */
            .chattie-toggle {
                width: 60px;
                height: 60px;
                background-color: ${primaryColor};
                border-radius: 50%;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: transform 0.2s;
                color: white;
                border: none;
            }
            .chattie-toggle:hover {
                transform: scale(1.05);
            }
            .chattie-toggle svg {
                width: 32px;
                height: 32px;
                fill: currentColor;
            }

            /* Window Container */
            .chattie-window {
                width: 380px;
                height: 600px;
                background: white;
                box-shadow: 0 5px 40px rgba(0,0,0,0.16);
                border-radius: 16px;
                overflow: hidden;
                display: none;
                flex-direction: column;
                animation: chattie-slide-in 0.3s ease-out;
                transition: width 0.3s, height 0.3s;
                position: relative;
            }
            .chattie-window.open {
                display: flex;
            }
            .chattie-window.expanded {
                width: 600px;
                height: 80vh;
                max-width: 90vw;
            }
            @keyframes chattie-slide-in {
                from { opacity: 0; transform: translateY(20px); }
                to { opacity: 1; transform: translateY(0); }
            }

            /* Dropdown Menu */
            .chattie-menu-btn {
                cursor: pointer;
                opacity: 0.8;
                transition: opacity 0.2s;
                color: white;
            }
            .chattie-menu-btn:hover {
                opacity: 1;
            }
            .chattie-dropdown {
                position: absolute;
                top: 60px;
                right: 20px;
                background: white;
                border-radius: 12px;
                box-shadow: 0 10px 25px rgba(0,0,0,0.15);
                width: 220px;
                opacity: 0;
                transform: translateY(-10px);
                pointer-events: none;
                transition: all 0.2s;
                z-index: 10001;
                color: #334155;
                text-align: left;
                border: 1px solid #e2e8f0;
            }
            .chattie-dropdown.active {
                opacity: 1;
                transform: translateY(0);
                pointer-events: auto;
            }
            .chattie-dropdown-header {
                padding: 12px 16px;
                font-size: 12px;
                font-weight: 600;
                color: #94a3b8;
                border-bottom: 1px solid #f1f5f9;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .chattie-dropdown-list {
                padding: 8px;
            }
            .chattie-dropdown-item {
                padding: 10px 12px;
                font-size: 14px;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 12px;
                transition: background 0.1s;
                border-radius: 8px;
                color: #475569;
            }
            .chattie-dropdown-item:hover {
                background: #f1f5f9;
                color: #1e293b;
            }
            .chattie-dropdown-item svg {
                width: 18px;
                height: 18px;
                color: #64748b;
            }

            /* --- THEME STYLES --- */
            
            /* Window Modifiers */
            .chattie-window.modern {
                 border-radius: 16px;
                 height: 600px;
            }
            .chattie-window.classic {
                 border-radius: 16px;
                 height: 600px;
                 box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
            }
            .chattie-window.minimal {
                 border-radius: 16px;
                 height: 600px;
                 border: 1px solid #e2e8f0;
            }
            .chattie-window.bold {
                 border-radius: 16px;
                 height: 600px;
                 background-color: #0f172a;
                 color: white;
                 border: 1px solid #1e293b;
            }

            /* Headers */
            .chattie-header-modern, .chattie-header-bold {
                min-height: 140px;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 24px;
                text-align: center;
                position: relative;
            }
            .chattie-header-modern {
                background-color: ${primaryColor};
                color: white;
            }
            .chattie-header-bold {
                background-color: #0f172a;
                color: white;
                border-bottom: 1px solid #1e293b;
            }

            .chattie-header-classic {
                background-color: ${primaryColor};
                color: white;
                min-height: 70px;
                height: auto;
                padding: 10px 20px 16px 20px;
                display: flex;
                flex-direction: column;
                justify-content: center;
                border-bottom-right-radius: 100% 20px;
                border-bottom-left-radius: 100% 20px;
                position: relative;
                z-index: 10;
            }

            .chattie-header-minimal {
                background-color: #ffffff;
                color: #1e293b;
                min-height: 80px;
                padding: 16px 20px;
                display: flex;
                flex-direction: row;
                justify-content: space-between;
                align-items: center;
                border-bottom: 1px solid #f1f5f9;
                position: relative;
                z-index: 10;
            }

            .chattie-header-actions {
                position: absolute;
                top: 16px;
                right: 16px;
                z-index: 10;
            }

            /* Avatars & Icons (for compatibility if needed, though mostly replaced) */
            .chattie-modern-avatars { display: flex; margin-bottom: 12px; }
            .chattie-avatar { width: 48px; height: 48px; border-radius: 50%; border: 2px solid white; margin-left: -12px; object-fit: cover; background: white; }
            .chattie-avatar:first-child { margin-left: 0; }


            /* --- BODY & MESSAGES --- */
            .chattie-body {
                flex: 1;
                padding: 16px;
                background: white;
                overflow-y: auto;
                overscroll-behavior: contain; /* Prevents background scrolling */
            }

            /* Minimal Theme Grid Background with Fade */
            .chattie-window.minimal .chattie-body {
                background-color: #ffffff;
                background-image: 
                    radial-gradient(circle at center, transparent 40%, #ffffff 100%),
                    linear-gradient(#f1f5f9 1px, transparent 1px),
                    linear-gradient(90deg, #f1f5f9 1px, transparent 1px);
                background-size: 100% 100%, 24px 24px, 24px 24px;
                background-position: center center;
            }
            .chattie-date {
                text-align: center;
                font-size: 12px;
                color: #94a3b8;
                margin-bottom: 24px;
            }
            .chattie-message-group {
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                margin-bottom: 16px;
            }
            .chattie-bubble {
                max-width: 90%; // Increased for symmetry (v10)
                padding: 12px;
                font-size: 14px;
                line-height: 1.4;
                width: fit-content;
                min-width: 50px;
                flex-shrink: 0;
                word-break: normal;
            }
            .chattie-bubble-modern {
                background-color: ${primaryColor};
                color: white;
                border-radius: 12px;
                border-top-right-radius: 2px;
            }
            .chattie-read-receipt {
                font-size: 10px;
                color: #94a3b8;
                margin-top: 4px;
                display: flex;
                align-items: center;
                gap: 4px;
            }

            /* --- INPUT AREA --- */
            .chattie-input-modern {
                padding: 16px;
                border-top: 1px solid #f1f5f9;
                position: relative;
            }
            .chattie-input-field-modern {
                width: 100%;
                padding: 12px 48px 12px 16px;
                border: none;
                font-size: 14px;
                color: #334155;
                outline: none;
                box-sizing: border-box;
                background: #f8fafc;
                border-radius: 8px;
            }
            .chattie-input-icons {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-top: 12px;
                border-top: 1px solid #f1f5f9;
                padding-top: 12px;
                color: #94a3b8;
            }
            .chattie-icon-group {
                display: flex;
                gap: 12px;
            }
            .chattie-icon-group svg {
                width: 20px;
                height: 20px;
                cursor: pointer;
            }
            .chattie-icon-group svg:hover {
                color: #475569;
            }
            
            /* FIX: extensive formatting reset for message content */
            .chattie-bubble b, .chattie-bubble strong {
                font-weight: bold;
                color: inherit;
            }
            .chattie-bubble i, .chattie-bubble em {
                font-style: italic;
                color: inherit;
            }
            .chattie-bubble u {
                text-decoration: underline;
                color: inherit;
            }
            .chattie-bubble s, .chattie-bubble strike {
                text-decoration: line-through;
                color: inherit;
            }
            .chattie-bubble ul, .chattie-bubble ol {
                margin: 4px 0 4px 20px;
                padding: 0;
                list-style-position: outside;
                color: inherit;
            }
            .chattie-bubble ul { list-style-type: disc; }
            .chattie-bubble ol { list-style-type: decimal; }
            .chattie-bubble li { margin-bottom: 2px; }
            .chattie-bubble a { color: inherit; text-decoration: underline;}

            /* Old styles removed to fix alignment */
            .chattie-branding {
                font-size: 10px;
                color: #cbd5e1;
            }

            /* Typing Indicator */
            .chattie-typing {
                padding: 12px;
                display: none;
                align-items: center;
                gap: 4px;
                color: #94a3b8;
                font-size: 12px;
            }
            .chattie-typing-dots {
                display: flex;
                gap: 3px;
            }
            .chattie-dot {
                width: 4px;
                height: 4px;
                background: #cbd5e1;
                border-radius: 50%;
                animation: typing 1.4s infinite ease-in-out;
            }
            .chattie-dot:nth-child(1) { animation-delay: 0s; }
            .chattie-dot:nth-child(2) { animation-delay: 0.2s; }
            .chattie-dot:nth-child(3) { animation-delay: 0.4s; }

            @keyframes typing {
                0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
                40% { transform: scale(1); opacity: 1; }
            }
                /* --- INPUT AREA CONTAINERS --- */
                .chattie-input-modern, .chattie-input-bold {
                    padding: 16px;
                    border-top: 1px solid ${theme === 'bold' ? '#1e293b' : '#f1f5f9'};
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    ${theme === 'bold' ? 'background-color: #0f172a;' : ''}
                }
                .chattie-input-wrapper {
                    position: relative;
                    width: 100%;
                }

                /* --- FORMATTING TOOLBAR --- */
                .chattie-format-toolbar {
                    display: flex;
                    gap: 4px;
                    padding: 0 4px;
                }
                .chattie-format-btn {
                    background: none;
                    border: 1px solid transparent;
                    cursor: pointer;
                    color: ${theme === 'bold' ? '#94a3b8' : '#64748b'};
                    padding: 6px;
                    border-radius: 6px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                    width: 32px;
                    height: 32px;
                }
                .chattie-format-btn:hover, .chattie-format-btn.active {
                    color: ${primaryColor};
                    background: ${theme === 'bold' ? '#1e293b' : '#f1f5f9'};
                    border-color: ${theme === 'bold' ? '#334155' : '#e2e8f0'};
                }
                
                /* --- EMOJI PICKER --- */
                .chattie-emoji-picker {
                    position: absolute;
                    bottom: 100%;
                    left: 0;
                    margin-bottom: 8px;
                    background: white;
                    border: 1px solid #e2e8f0;
                    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
                    border-radius: 12px;
                    display: none;
                    width: 350px;
                    max-height: 400px;
                    overflow: hidden;
                    z-index: 10002;
                    overscroll-behavior: contain;
                }
                .chattie-emoji-picker.active {
                    display: block;
                }
                
                /* Style the emoji picker element (full version) */
                .chattie-emoji-picker emoji-picker {
                    --border-radius: 12px;
                    --background: white;
                    --border-color: transparent;
                    --indicator-color: ${primaryColor};
                    --button-active-background: #f1f5f9;
                    --button-hover-background: #f8fafc;
                    width: 100%;
                    height: 100%;
                    overscroll-behavior: contain;
                }
                
                /* --- INPUT FIELD & SEND BUTTON --- */
                .chattie-input-box {
                    display: flex;
                    align-items: flex-end;
                    border: 1px solid ${theme === 'bold' ? '#1e293b' : '#e2e8f0'};
                    background: ${theme === 'bold' ? '#1e293b' : '#f8fafc'};
                    border-radius: 12px;
                    padding: 4px 8px; /* Reduced vertical padding slightly for tighter fit */
                    position: relative;
                }
                .chattie-input-box:focus-within {
                    ${theme === 'bold' ? '' : 'background: white;'}
                    border-color: ${primaryColor};
                    box-shadow: 0 0 0 2px ${primaryColor}1a;
                }

                .chattie-input-field-modern {
                    flex: 1;
                    min-height: 24px;
                    max-height: 120px;
                    padding: 8px;
                    border: none;
                    background: transparent;
                    font-size: 14px;
                    color: ${theme === 'bold' ? '#f1f5f9' : '#334155'};
                    outline: none;
                    box-sizing: border-box;
                    overflow-y: auto;
                    white-space: pre-wrap;
                    line-height: 1.5;
                }
                
                .chattie-send-modern {
                    width: 32px;
                    height: 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: #94a3b8;
                    cursor: pointer;
                    transition: all 0.2s;
                    border-radius: 50%;
                    flex-shrink: 0;
                    margin-left: 8px;
                    margin-bottom: 4px;
                }
                .chattie-send-modern:hover {
                    color: white;
                    background: ${primaryColor};
                }

                .chattie-util-btn {
                    background: none;
                    border: none;
                    width: 32px;
                    height: 32px;
                    cursor: pointer;
                    color: #94a3b8;
                    transition: all 0.2s;
                    border-radius: 6px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: bold;
                    font-size: 13px;
                    flex-shrink: 0;
                }
                .chattie-util-btn:hover {
                    color: ${primaryColor};
                    background: ${theme === 'bold' ? '#334155' : '#f1f5f9'};
                }
                .chattie-util-btn.active {
                    color: ${primaryColor};
                    background: ${primaryColor}1a;
                }
                .chattie-format-toolbar-popup {
                    display: none;
                    position: absolute;
                    bottom: 100%;
                    right: 48px;
                    margin-bottom: 8px;
                    background: white;
                    border: 1px solid #e2e8f0;
                    border-radius: 8px;
                    box-shadow: 0 10px 25px rgba(0,0,0,0.1);
                    padding: 4px;
                    z-index: 10003;
                    gap: 2px;
                    align-items: center;
                }
                .chattie-format-toolbar-popup.active {
                    display: flex;
                }
                .chattie-format-toolbar-popup .chattie-format-btn {
                    width: 32px;
                    height: 32px;
                    padding: 6px;
                }
                
            /* Placeholder for contenteditable */
            #chattie-input:empty:before,
            .chattie-input-field-modern:empty:before {
                content: attr(placeholder);
                color: #94a3b8;
                pointer-events: none;
                display: block;
            }
            /* Fallback if browser inserts BR */
            .chattie-input-field-modern:focus:empty:before {
                content: "";
            }
            div[placeholder]:empty:before {
                content: attr(placeholder);
                color: #94a3b8;
                pointer-events: none;
                display: block;
            }

            /* Image Preview Modal */
            .chattie-img-modal {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.85);
                display: none;
                align-items: center;
                justify-content: center;
                z-index: 100000;
                cursor: zoom-out;
                opacity: 0;
                transition: opacity 0.2s ease;
            }
            .chattie-img-modal.active {
                opacity: 1;
            }
            .chattie-img-modal img {
                max-width: 90%;
                max-height: 90%;
                border-radius: 8px;
                box-shadow: 0 5px 30px rgba(0,0,0,0.3);
                transform: scale(0.9);
                transition: transform 0.2s ease;
            }
            .chattie-img-modal.active img {
                transform: scale(1);
            }
            .chattie-img-modal-close {
                position: absolute;
                top: 20px;
                right: 20px;
                color: white;
                cursor: pointer;
                background: rgba(255,255,255,0.1);
                border-radius: 50%;
                width: 40px;
                height: 40px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background 0.2s;
            }
            .chattie-img-modal-close:hover {
                background: rgba(255,255,255,0.2);
            }
        `;
        document.head.appendChild(style);

        // --- DOM STRUCTURE ---
        root = document.createElement("div");
        root.id = "chattie-root";

        let headerContent = "";

        // --- DROPDOWN MENU HTML ---
        const dropdownHTML = `
            <div class="chattie-dropdown" id="chattie-dropdown">
                <div class="chattie-dropdown-header">Quick Actions</div>
                <div class="chattie-dropdown-list">
                    <div class="chattie-dropdown-item" id="action-minimize">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
                        Minimize chat
                    </div>
                    <div class="chattie-dropdown-item" id="action-expand">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
                        Expand view
                    </div>
                    <div class="chattie-dropdown-item" id="action-new">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>
                        New conversation
                    </div>
                </div>
            </div>
        `;

        if (theme === 'classic') {
            // === CLASSIC THEME HTML ===
            headerContent = `
                <div class="chattie-header-classic">
                    <div class="chattie-header-actions" style="position: absolute; top: 20px; right: 20px;">
                         <div class="chattie-menu-btn" id="chattie-menu-toggle">
                             <svg width="24" height="24" fill="currentColor" viewBox="0 0 20 20"><path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" /></svg>
                         </div>
                    </div>
                    
                    <div style="display: flex; flex-direction: column; align-items: center; text-align: center;">
                        ${logoUrl ? `
                        <div style="margin-bottom: 4px;">
                            <img src="${logoUrl}" style="width: ${logoSize}px; height: ${logoSize}px; object-fit: contain; border-radius: 50%; background: white; padding: 4px;" alt="Logo" />
                        </div>
                        ` : ''}
                        
                         <h3 style="font-weight: bold; font-size: ${productNameSize}px; color: ${headerTextColor}; transform: translate(${productNameX}px, ${productNameY}px); display: inline-block;">
                            ${headerText || `Talk with ${projectConfig?.projectName || "Support"}! 👋`}
                        </h3>
                    </div>
                </div>
                ${dropdownHTML}
            `;
        } else if (theme === 'minimal') {
            // === MINIMAL THEME HTML ===
            headerContent = `
                <div class="chattie-header-minimal">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        ${logoUrl ? `
                            <img src="${logoUrl}" style="width: ${logoSize}px; height: auto; max-height: 40px; object-fit: contain;" alt="Logo" />
                        ` : `
                            <div style="width: 32px; height: 32px; border-radius: 50%; background: #f1f5f9; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; color: #64748b;">
                                ${companyName ? companyName[0] : 'B'}
                            </div>
                        `}
                        <div>
                            <h3 style="font-weight: bold; font-size: 16px; color: #1e293b; margin: 0;">
                                ${headerText || productName || "Support"}
                            </h3>
                        </div>
                    </div>

                    <div class="chattie-header-actions" style="position: static;">
                         <div class="chattie-menu-btn" id="chattie-menu-toggle" style="color: #64748b;">
                             <svg width="24" height="24" fill="currentColor" viewBox="0 0 20 20"><path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" /></svg>
                         </div>
                    </div>
                </div>
                ${dropdownHTML}
            `;
        } else {
            // === MODERN / BOLD THEME HTML ===
            const headerClass = theme === 'bold' ? 'chattie-header-bold' : 'chattie-header-modern';
            headerContent = `
                <div class="${headerClass}" style="display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; border-bottom-left-radius: 40px; border-bottom-right-radius: 40px; padding-bottom: 48px;">
                    <div class="chattie-header-actions">
                         <div class="chattie-menu-btn" id="chattie-menu-toggle">
                             <svg width="24" height="24" fill="currentColor" viewBox="0 0 20 20"><path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" /></svg>
                         </div>
                    </div>
                    
                    <!-- LOGO in Flow -->
                    ${logoUrl ? `
                    <div style="margin-bottom: 12px; z-index: 5;">
                        <img src="${logoUrl}" style="width: ${logoSize}px; height: auto; object-fit: contain;" alt="Logo" />
                    </div>
                    ` : ''}
                    
                    <!-- TITLE in Flow -->
                    <div style="position: relative;">
                        <div style="font-weight: bold; font-size: ${productNameSize}px; color: ${headerTextColor}; display: inline-block;">
                            ${headerText || `Talk with ${projectConfig?.projectName || "Support"}! 👋`}
                        </div>
                    </div>
                </div>
                ${dropdownHTML}
            `;
        }

        // === BODY & INPUT (Shared across themes) ===
        const supportLogoImg = projectConfig?.widgetConfig?.supportLogoUrl || projectConfig?.widgetConfig?.logoUrl;
        let supportAvatarHTML = "";
        if (supportLogoImg) {
            supportAvatarHTML = `<img src="${supportLogoImg}" style="width: 28px; height: 28px; border-radius: 50%; object-fit: cover; flex-shrink: 0;" alt="Support" />`;
        } else {
            supportAvatarHTML = `<div style="width: 28px; height: 28px; border-radius: 50%; background-color: #cbd5e1; flex-shrink: 0; display: flex; align-items: center; justify-content: center;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>`;
        }

        let welcomeBubbleStyle = "";
        if (theme === 'minimal') {
            welcomeBubbleStyle = "background-color: #ffffff; color: #1e293b; border: 1px solid #e2e8f0; border-radius: 12px; border-bottom-left-radius: 2px; padding: 12px; font-size: 14px; line-height: 1.4; box-shadow: 0 1px 2px rgba(0,0,0,0.05); width: fit-content; max-width: 100%; display: inline-block;";
        } else if (theme === 'classic' || theme === 'modern') {
            welcomeBubbleStyle = "background-color: #EAEAEA; color: #868686; border-radius: 12px; border-bottom-left-radius: 2px; padding: 12px; font-size: 14px; line-height: 1.4; width: fit-content; max-width: 100%; display: inline-block;";
        } else {
            welcomeBubbleStyle = "background-color: #f1f5f9; color: #1e293b; border-radius: 12px; border-bottom-left-radius: 2px; padding: 12px; font-size: 14px; line-height: 1.4; width: fit-content; max-width: 100%; display: inline-block;";
        }

        headerContent += `
            <div class="chattie-body" id="chattie-body">
                <div class="chattie-date">${new Date().toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })}</div>
                <div id="chattie-typing-indicator" class="chattie-typing">
                    <div class="chattie-typing-dots">
                        <div class="chattie-dot"></div>
                        <div class="chattie-dot"></div>
                        <div class="chattie-dot"></div>
                    </div>
                    <span>Support is typing...</span>
                </div>
            </div>

            <div class="chattie-input-area ${theme === 'bold' ? 'chattie-input-bold' : 'chattie-input-modern'}">
                <div class="chattie-input-wrapper">
                    <!-- Formatting Toolbar Popup -->
                    <div class="chattie-format-toolbar-popup" id="chattie-format-popup">
                        <button class="chattie-format-btn" id="fmt-bold" title="Bold">
                            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6V4zm0 8h9a4 4 0 014 4 4 4 0 01-4 4H6v-8z" /></svg>
                        </button>
                        <button class="chattie-format-btn" id="fmt-italic" title="Italic">
                            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l2.3 8m-2.8 0h6m-12 0H12" /><path d="M19 4h-9m4 16h9" stroke="none" /></svg> 
                        </button>
                        <button class="chattie-format-btn" id="fmt-underline" title="Underline">
                            <span style="text-decoration: underline; font-family: serif; font-size: 16px;">U</span>
                        </button>
                    </div>

                    <!-- Emoji Picker -->
                    <div class="chattie-emoji-picker" id="chattie-emoji-picker"></div>
                    
                    <!-- Box containing Input + Send Button -->
                    <div class="chattie-input-box">
                        <div id="chattie-input" class="chattie-input-field-modern" contenteditable="true" placeholder="Type message here"></div>
                        
                        <!-- Utility buttons -->
                        <div style="display: flex; align-items: center; gap: 2px; margin-right: 4px; flex-shrink: 0;">
                            <button class="chattie-util-btn" id="chattie-toggle-fmt" title="Formatting">Aa</button>
                            <button class="chattie-util-btn" id="fmt-emoji" title="Emoji">
                                <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            </button>
                            <button class="chattie-util-btn" id="chattie-attach-btn" title="Attach File">
                                <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                            </button>
                        </div>

                        <div class="chattie-send-modern" id="chattie-send-btn" title="Send">
                            <svg width="20" height="20" fill="none" class="chattie-rotate-90" stroke="currentColor" viewBox="0 0 24 24" style="transform: rotate(90deg);"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                        </div>
                    </div>
                </div>

                <input type="file" id="chattie-file-input" accept="image/*" style="display: none;" />
            </div>
        `;

        const windowDiv = document.createElement("div");
        windowDiv.className = `chattie-window ${theme}`;
        windowDiv.innerHTML = headerContent;

        const closeIcon = `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>`;
        const chatIcon = `<svg viewBox="0 0 24 24"><path d="M12 2C6.477 2 2 6.477 2 12c0 1.821.487 3.53 1.338 5.025.84 1.473-.294 3.864-1.226 4.796a1 1 0 001.07 1.62c2.65-.967 4.545-1.574 5.927-1.39A9.957 9.957 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2zM8 12a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm4 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm4 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/></svg>`;

        // Toggle Button HTML
        const toggleHTML = `
            <div class="chattie-toggle" style="position: relative;">
                <div id="chattie-unread-indicator" style="display: none; position: absolute; top: 0; right: 0; background: #ef4444; color: white; border-radius: 50%; min-width: 18px; height: 18px; font-size: 10px; align-items: center; justify-content: center; font-weight: bold; border: 2px solid white; z-index: 10;">0</div>
                <div id="chattie-toggle-icon-container" style="display: flex; align-items: center; justify-content: center;">
                    ${chatIcon}
                </div>
            </div>
        `;

        root.appendChild(windowDiv);
        const toggleWrapper = document.createElement("div");
        toggleWrapper.innerHTML = toggleHTML;
        root.appendChild(toggleWrapper.firstElementChild);

        // Image Preview Modal
        const imgModal = document.createElement("div");
        imgModal.className = "chattie-img-modal";
        imgModal.id = "chattie-img-modal";
        imgModal.innerHTML = `
            <div class="chattie-img-modal-close">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </div>
            <img id="chattie-img-modal-content" src="" alt="Preview" />
        `;
        document.body.appendChild(imgModal);

        imgModal.onclick = () => {
            imgModal.classList.remove("active");
            setTimeout(() => { if (!imgModal.classList.contains('active')) imgModal.style.display = 'none'; }, 200);
        };

        document.body.appendChild(root);

        // Update indicator with saved count
        updateUnreadIndicator();

        // --- DOM ELEMENTS & EVENTS ---
        const toggleBtn = root.querySelector(".chattie-toggle");
        const menuBtn = root.querySelector("#chattie-menu-toggle");
        const dropdown = root.querySelector("#chattie-dropdown");
        const chatBody = root.querySelector("#chattie-body");
        // Listen for typing indicator from support
        function attachSocketListeners() {
            if (socket) {
                socket.on('user_typing', (data) => {
                    let typingData = data;

                    // Decrypt token if present
                    if (data.token) {
                        try {
                            const decryptedJSON = decryptMessage(data.token);
                            if (decryptedJSON !== data.token) {
                                typingData = JSON.parse(decryptedJSON);
                            }
                        } catch (e) {
                            console.error("❌ Failed to decrypt user_typing:", e);
                            return;
                        }
                    }

                    let typingIndicator = document.getElementById('chattie-typing-indicator');
                    if (!typingIndicator) {
                        typingIndicator = document.createElement('div');
                        typingIndicator.id = 'chattie-typing-indicator';
                        typingIndicator.className = 'chattie-typing';
                        typingIndicator.innerHTML = `
                            <div class="chattie-typing-dots">
                                <div class="chattie-dot"></div>
                                <div class="chattie-dot"></div>
                                <div class="chattie-dot"></div>
                            </div>
                            <span>Support is typing...</span>
                        `;
                    }

                    if (typingData.isTyping && (typingData.userType === 'support' || typingData.userType === 'admin')) {
                        const chatBody = document.querySelector("#chattie-body");
                        if (chatBody) {
                            // Ensure it's correctly appended to the bottom
                            chatBody.appendChild(typingIndicator);
                            typingIndicator.style.display = 'flex';
                            chatBody.scrollTop = chatBody.scrollHeight;
                        }
                    } else {
                        if (typingIndicator) {
                            typingIndicator.style.display = 'none';
                        }
                    }
                });
            } else {
                // Retry if socket is not ready yet
                setTimeout(attachSocketListeners, 500);
            }
        }
        attachSocketListeners();

        const chattieInput = root.querySelector("#chattie-input");
        const inputField = chattieInput; // Alias for compatibility with formatting logic
        const sendBtn = root.querySelector("#chattie-send-btn");

        let typingTimer;
        chattieInput.addEventListener('input', () => {
            if (socket) {
                const payload = {
                    projectId,
                    chatId,
                    userId,
                    userType: 'student',
                    isTyping: true
                };
                const token = encryptMessage(JSON.stringify(payload));
                socket.emit('typing', { token });
            }

            clearTimeout(typingTimer);
            typingTimer = setTimeout(() => {
                if (socket) {
                    const payload = {
                        projectId,
                        chatId,
                        userId,
                        userType: 'student',
                        isTyping: false
                    };
                    const token = encryptMessage(JSON.stringify(payload));
                    socket.emit('typing', { token });
                }
            }, 2000);
        });

        chattieInput.addEventListener("keypress", (e) => {
            if (e.key === "Enter") {
                handleSend();
            }
        });

        // Check for Email/Name Requirement Upfront
        const storedEmailCheck = secureStorage.getItem(storageKeys.email);

        // Always enforce onboarding to collect Name and Email based on user request
        if (!storedEmailCheck) {
            chattieInput.contentEditable = "false";
            chattieInput.style.opacity = "0.6";
            chattieInput.style.cursor = "not-allowed";
            chattieInput.setAttribute("placeholder", "Please provide contact details to start chatting...");
            chattieInput.innerText = "";

            sendBtn.style.pointerEvents = "none";
            sendBtn.style.opacity = "0.5";
            sendBtn.style.cursor = "not-allowed";

            const inputWrapper = root.querySelector('.chattie-input-wrapper');
            if (inputWrapper) inputWrapper.style.cursor = "not-allowed";

            showInlineChatEmailPrompt();
        }

        // --- ACTIONS ---

        // 1. Minimize Chat
        // Format & Emoji Elements
        const btnBold = root.querySelector("#fmt-bold");
        const btnItalic = root.querySelector("#fmt-italic");
        const btnUnderline = root.querySelector("#fmt-underline");
        const btnEmoji = root.querySelector("#fmt-emoji");
        const emojiPicker = root.querySelector("#chattie-emoji-picker");

        const btnMinimize = root.querySelector("#action-minimize");
        const btnExpand = root.querySelector("#action-expand");
        const btnNew = root.querySelector("#action-new");
        const btnToggleFmt = root.querySelector("#chattie-toggle-fmt");
        const formatPopup = root.querySelector("#chattie-format-popup");

        // Toggle Formatting Popup
        btnToggleFmt.addEventListener("click", (e) => {
            e.stopPropagation();
            formatPopup.classList.toggle("active");
            emojiPicker.classList.remove("active");
        });

        // Toggle Open/Close
        toggleBtn.addEventListener("click", () => {
            const isOpen = windowDiv.classList.contains("open");
            const iconContainer = toggleBtn.querySelector("#chattie-toggle-icon-container");

            if (isOpen) {
                windowDiv.classList.remove("open");
                if (iconContainer) iconContainer.innerHTML = chatIcon;
                dropdown.classList.remove("active");
            } else {
                windowDiv.classList.add("open");
                // When open, we don't show the indicator, just the close icon
                if (iconContainer) iconContainer.innerHTML = closeIcon;

                // Clear unread count when opening
                markAllAsRead();
            }
            // Scroll to the bottom to show the last message when opened
            setTimeout(() => {
                const cBody = document.querySelector("#chattie-body");
                if (cBody) {
                    cBody.scrollTop = cBody.scrollHeight;
                }
            }, 10);
        });

        // Toggle Quick Actions Menu
        menuBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            dropdown.classList.toggle("active");
            emojiPicker.classList.remove("active"); // Close emoji picker if open
        });

        // Close menu when clicking outside
        document.addEventListener("click", (e) => {
            if (!dropdown.contains(e.target) && !menuBtn.contains(e.target)) {
                dropdown.classList.remove("active");
            }
            // Close formatting popup if clicking outside
            if (formatPopup && !formatPopup.contains(e.target) && !btnToggleFmt.contains(e.target)) {
                formatPopup.classList.remove("active");
            }
            // Close emoji picker if clicking outside
            if (!emojiPicker.contains(e.target) && !btnEmoji.contains(e.target)) {
                emojiPicker.classList.remove("active");
            }
        });

        // --- FORMATTING LOGIC ---
        // --- FORMATTING LOGIC ---
        function checkFormats() {
            if (document.queryCommandState('bold')) btnBold.classList.add('active'); else btnBold.classList.remove('active');
            if (document.queryCommandState('italic')) btnItalic.classList.add('active'); else btnItalic.classList.remove('active');
            if (document.queryCommandState('underline')) btnUnderline.classList.add('active'); else btnUnderline.classList.remove('active');
        }

        function execFormat(command) {
            document.execCommand(command, false, null);
            inputField.focus();
            checkFormats();
        }

        inputField.addEventListener('keyup', checkFormats);
        inputField.addEventListener('mouseup', checkFormats);
        inputField.addEventListener('input', checkFormats);

        btnBold.addEventListener("mousedown", (e) => { e.preventDefault(); execFormat("bold"); });
        btnItalic.addEventListener("mousedown", (e) => { e.preventDefault(); execFormat("italic"); });
        btnUnderline.addEventListener("mousedown", (e) => { e.preventDefault(); execFormat("underline"); });

        // --- EMOJI PICKER LOGIC ---
        // Load emoji-picker-element dynamically
        const loadEmojiPicker = async () => {
            try {
                // Load the emoji picker module
                const { Picker } = await import('https://cdn.jsdelivr.net/npm/emoji-picker-element@^1/index.js');

                const picker = new Picker({
                    locale: 'en',
                    skinToneEmoji: '👍',
                    dataSource: 'https://cdn.jsdelivr.net/npm/emoji-picker-element-data@^1/en/emojibase/data.json'
                });

                // Inject custom scrollbar and overscroll-behavior into Shadow DOM 
                if (picker.shadowRoot) {
                    const style = document.createElement('style');
                    style.textContent = `
                        /* Custom Scrollbar */
                        ::-webkit-scrollbar { width: 5px; }
                        ::-webkit-scrollbar-thumb { background-color: #cbd5e1; border-radius: 4px; }
                        ::-webkit-scrollbar-track { background: transparent; }
                        
                        /* Prevent background scroll chaining */
                        :host, .picker, section, [role="tabpanel"] {
                            overscroll-behavior: contain !important;
                        }
                    `;
                    picker.shadowRoot.appendChild(style);
                }

                // Style the picker
                picker.style.width = '100%';
                picker.style.height = '310px';
                picker.style.border = 'none';
                picker.style.borderRadius = '0 0 12px 12px';
                picker.style.boxShadow = 'none';

                // Add to container
                if (emojiPicker) {
                    emojiPicker.innerHTML = '';

                    // Create Header with Close Button
                    const header = document.createElement('div');
                    header.style.display = 'flex';
                    header.style.justifyContent = 'flex-end';
                    header.style.padding = '8px 12px';
                    header.style.borderBottom = '1px solid #f1f5f9';
                    header.style.background = 'white';
                    header.style.borderRadius = '12px 12px 0 0';

                    const closeBtn = document.createElement('div');
                    closeBtn.innerHTML = '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>';
                    closeBtn.style.cursor = 'pointer';
                    closeBtn.style.color = '#94a3b8';
                    closeBtn.style.transition = 'color 0.2s';

                    // Hover effects
                    closeBtn.onmouseover = () => closeBtn.style.color = '#ef4444';
                    closeBtn.onmouseout = () => closeBtn.style.color = '#94a3b8';

                    // Close Action
                    closeBtn.onclick = (e) => {
                        e.stopPropagation();
                        emojiPicker.classList.remove('active');
                    };

                    header.appendChild(closeBtn);
                    emojiPicker.appendChild(header);
                    emojiPicker.appendChild(picker);

                    // Listen for emoji selection
                    picker.addEventListener('emoji-click', (event) => {
                        if (inputField) {
                            inputField.focus();
                            document.execCommand('insertText', false, event.detail.unicode);
                        }
                        // Optionally close picker after selection
                        // emojiPicker.classList.remove('active');
                    });
                }
            } catch (error) {
                console.error('Failed to load emoji picker:', error);

                // Show error message in the picker container
                if (emojiPicker) {
                    emojiPicker.innerHTML = '<div style="padding: 20px; text-align: center; color: #64748b; font-size: 14px;">Failed to load emojis.<br>Please check your internet connection.</div>';
                    emojiPicker.style.display = 'block';
                    emojiPicker.style.height = 'auto';
                }
            }
        };

        // Load emoji picker when button is first clicked
        let emojiPickerLoaded = false;
        btnEmoji.addEventListener("click", (e) => {
            e.stopPropagation();

            if (!emojiPickerLoaded) {
                emojiPickerLoaded = true;
                loadEmojiPicker();
            }

            emojiPicker.classList.toggle("active");
        });

        function insertAtCursor(text) {
            chattieInput.focus();
            document.execCommand("insertText", false, text);
        }

        // --- MESSAGE SENDING ---
        let pendingFile = null; // Store file waiting to be sent

        function handleSend() {
            if (isRatingPending) return;
            const chattieInput = root.querySelector('.chattie-input-field-modern') || root.querySelector('.chattie-input-field');
            if (!chattieInput) return;
            const messageConfig = chattieInput.innerHTML;
            const plainText = chattieInput.textContent.trim();
            const hasContent = plainText.length > 0 || chattieInput.querySelector('img');

            if (window.chattieEditingMessageId) {
                if (hasContent) {
                    const token = secureStorage.getItem(storageKeys.token);
                    const headers = { 'Content-Type': 'application/json' };
                    if (token) headers["Authorization"] = `Bearer ${token}`;

                    fetch(`${API_BASE}/api/messages/${projectId}/${chatId}/${window.chattieEditingMessageId}`, {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({
                            message: messageConfig,
                            messageType: 'text'
                        })
                    }).then(res => res.json()).then(data => {
                        if (data.success) {
                            window.chattieEditingMessageId = null;
                            chattieInput.textContent = '';
                        }
                    }).catch(err => console.error("Error updating message", err));
                } else {
                    window.chattieEditingMessageId = null;
                    chattieInput.textContent = '';
                }
                return;
            }

            if (pendingFile) {
                // Send file with caption if text exists
                // Use plainText check to avoid sending empty HTML as caption
                const caption = plainText.length > 0 ? messageConfig : null;
                uploadFile(pendingFile, caption);

                pendingFile = null;
                removeFilePreview();
                chattieInput.textContent = '';
            } else if (hasContent) {
                // Send text only
                sendMessage(messageConfig);
                chattieInput.textContent = '';
            }
        }

        function showFilePreview(file) {
            // Remove any existing preview
            removeFilePreview();

            const isImage = file.type.startsWith('image/');
            const previewContainer = document.createElement('div');
            previewContainer.id = 'chattie-file-preview';
            previewContainer.style.cssText = `
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 12px;
                background: #f1f5f9;
                border-radius: 8px;
                margin-bottom: 8px;
                position: relative;
            `;

            if (isImage) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const img = document.createElement('img');
                    img.src = e.target.result;
                    img.style.cssText = 'width: 60px; height: 60px; object-fit: cover; border-radius: 6px;';
                    previewContainer.insertBefore(img, previewContainer.firstChild);
                };
                reader.readAsDataURL(file);
            } else {
                const fileIcon = document.createElement('div');
                fileIcon.innerHTML = '📎';
                fileIcon.style.fontSize = '24px';
                previewContainer.appendChild(fileIcon);
            }

            const fileInfo = document.createElement('div');
            fileInfo.style.flex = '1';
            fileInfo.innerHTML = `
                <div style="font-size: 13px; font-weight: 500; color: #1e293b;">${file.name}</div>
                <div style="font-size: 11px; color: #64748b;">${(file.size / 1024).toFixed(1)} KB</div>
            `;
            previewContainer.appendChild(fileInfo);

            const removeBtn = document.createElement('button');
            removeBtn.innerHTML = '✕';
            removeBtn.style.cssText = `
                background: none;
                border: none;
                color: #64748b;
                font-size: 18px;
                cursor: pointer;
                padding: 4px 8px;
                border-radius: 4px;
            `;
            removeBtn.onmouseover = () => removeBtn.style.background = '#e2e8f0';
            removeBtn.onmouseout = () => removeBtn.style.background = 'none';
            removeBtn.onclick = () => {
                pendingFile = null;
                removeFilePreview();
            };
            previewContainer.appendChild(removeBtn);

            const inputWrapper = root.querySelector('.chattie-input-wrapper');
            inputWrapper.insertBefore(previewContainer, inputWrapper.firstChild);
        }

        function removeFilePreview() {
            const preview = document.getElementById('chattie-file-preview');
            if (preview) preview.remove();
        }

        // --- UPLOAD FILE ---
        function uploadFile(file, caption = null) {
            const formData = new FormData();
            formData.append("file", file);

            // Determine if image or generic file
            const isImage = file.type.startsWith('image/');
            const messageType = isImage ? 'image' : 'file';
            const fileName = file.name;



            // Show uploading state
            const tempId = `temp-${Date.now()}`;
            const tempDiv = document.createElement("div");
            tempDiv.id = tempId;
            tempDiv.className = "chattie-message-group";
            tempDiv.style.alignItems = "flex-end";
            tempDiv.innerHTML = `<div class="chattie-bubble" style="background-color: #e2e8f0; color: #1e293b; border-radius: 12px; padding: 12px;">Uploading ${isImage ? 'image' : 'file'}...</div>`;
            chatBody.appendChild(tempDiv);
            chatBody.scrollTop = chatBody.scrollHeight;

            const token = secureStorage.getItem(storageKeys.token);
            const headers = {};
            if (token) {
                headers["Authorization"] = `Bearer ${token}`;
            }

            fetch(`${API_BASE}/api/upload`, {
                method: "POST",
                headers,
                body: formData
            })
                .then(res => {
                    return res.json();
                })
                .then(data => {
                    const tempEl = document.getElementById(tempId);
                    if (tempEl) chatBody.removeChild(tempEl);

                    if (data.success) {
                        // Safety net: block if rating became pending while upload was in flight
                        if (isRatingPending) {
                            alert('Please submit your rating before sending a file.');
                            return;
                        }
                        const messageData = {
                            projectId,
                            chatId,
                            senderType: 'student',
                            senderId: userId,
                            messageType: messageType,
                            message: isImage ? (caption || '') : fileName,
                            fileName: fileName,
                            fileUrl: data.fileUrl
                        };
                        const token = encryptMessage(JSON.stringify(messageData));
                        socket.emit('send_message', { token });
                    } else {
                        console.error('❌ Upload failed:', data.message || 'Unknown error');
                        alert(`Failed to upload file: ${data.message || 'Unknown error'}`);
                    }
                })
                .catch(err => {
                    const tempEl = document.getElementById(tempId);
                    if (tempEl) chatBody.removeChild(tempEl);
                    console.error("❌ Upload error:", err);
                    alert(`Error uploading file: ${err.message}`);
                });
        }

        const attachBtn = root.querySelector("#chattie-attach-btn");
        const fileInput = root.querySelector("#chattie-file-input");

        attachBtn.addEventListener("click", () => {
            fileInput.click();
        });

        fileInput.addEventListener("change", (e) => {
            if (e.target.files && e.target.files[0]) {
                const file = e.target.files[0];
                if (file.type.startsWith('image/')) {
                    pendingFile = file;
                    showFilePreview(file);
                } else {
                    alert('Only image files are allowed.');
                }
                fileInput.value = ''; // Reset
            }
        });

        chattieInput.addEventListener("paste", (e) => {
            const items = (e.clipboardData || e.originalEvent.clipboardData).items;
            for (let i = 0; i < items.length; i++) {
                // Support generic file paste if possible, but browsers mostly expose images
                if (items[i].kind === 'file') {
                    const file = items[i].getAsFile();
                    if (file && file.type.startsWith('image/')) {
                        pendingFile = file;
                        showFilePreview(file);
                        e.preventDefault();
                    }
                }
            }
        });

        sendBtn.addEventListener("click", handleSend);

        chattieInput.addEventListener("keypress", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault(); // Prevent new line
                handleSend();
            }
        });

        // --- ACTIONS ---

        // 1. Minimize Chat
        btnMinimize.addEventListener("click", () => {
            windowDiv.classList.remove("open");
            toggleBtn.innerHTML = chatIcon;
            dropdown.classList.remove("active");
        });

        // 2. Expand / Collapse View
        const expandIcon = `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>`;
        const collapseIcon = `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" /></svg>`;

        btnExpand.addEventListener("click", () => {
            const isExpanded = windowDiv.classList.toggle("expanded");
            // Update label and icon to reflect current state
            btnExpand.innerHTML = isExpanded
                ? `${collapseIcon} Collapse view`
                : `${expandIcon} Expand view`;
            dropdown.classList.remove("active");
        });

        // 3. New Conversation
        btnNew.addEventListener("click", () => {
            if (socket) {
                const chatBody = document.querySelector("#chattie-body");
                if (chatBody) {
                    chatBody.innerHTML = '';
                    lastRenderedDate = null;
                }

                // Clear local message arrays
                messages = [];
                allMessagesMap.clear();

                // Keep the same chatId, just emit restart_chat to get the "New conversation started..." system message
                const payload = { projectId, chatId, userId };
                const token = encryptMessage(JSON.stringify(payload));
                socket.emit('restart_chat', { token });
            }
            dropdown.classList.remove("active");
        });
    }

    // ── Session loss monitor ─────────────────────────────────────────────────
    // Polls every 2 seconds to detect if localStorage was manually cleared
    // (same-tab clear is NOT caught by the native 'storage' event).
    // When session is gone, instantly shows the inline email form without a page refresh.
    function startSessionMonitor() {
        setInterval(() => {
            const chatBody = document.querySelector('#chattie-body');
            if (!chatBody) return;

            // ── Bug #2 fix: skip while a session reset is in progress
            // (chat_force_logout is being handled — socket is reconnecting)
            if (sessionIsBeingReset) return;

            const stillHasEmail = secureStorage.getItem(storageKeys.email);

            if (stillHasEmail) return; // session intact (user is known + identified)

            if (document.getElementById('chattie-inline-form-container')) return; // already showing

            // Disable input
            const inputEl = document.querySelector('#chattie-input');
            const sendBtn = document.querySelector('#chattie-send-btn');
            const wrapper = document.querySelector('.chattie-input-wrapper');
            if (inputEl) {
                inputEl.contentEditable = 'false';
                inputEl.style.opacity = '0.6';
                inputEl.style.cursor = 'not-allowed';
                inputEl.setAttribute('placeholder', 'Please provide contact details to start chatting...');
                inputEl.innerText = '';
            }
            if (sendBtn) { sendBtn.style.pointerEvents = 'none'; sendBtn.style.opacity = '0.5'; sendBtn.style.cursor = 'not-allowed'; }
            if (wrapper) wrapper.style.cursor = 'not-allowed';

            showInlineChatEmailPrompt();
        }, 2000);
    }

})();
