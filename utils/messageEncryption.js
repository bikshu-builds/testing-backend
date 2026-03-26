
import crypto from "crypto";
import dotenv from 'dotenv';
dotenv.config();

const ENCRYPTION_KEY_RAW = process.env.MESSAGE_JWT_SECRET;
if (!ENCRYPTION_KEY_RAW) {
    throw new Error("FATAL: MESSAGE_JWT_SECRET environment variable is required for message encryption");
}

// Derive a stable 32-byte AES key from the raw secret (same derivation as before)
const deriveKey = () =>
    crypto.createHash('sha256').update(String(ENCRYPTION_KEY_RAW)).digest();

// Separate 32-byte HMAC key derived from same master secret
const deriveHMACKey = () =>
    crypto.createHash('sha256').update(ENCRYPTION_KEY_RAW + '|mac').digest();

/**
 * Encrypts a message using AES-256-GCM (authenticated encryption).
 *
 * AES-256-GCM provides BOTH confidentiality AND integrity in a single pass.
 * The 16-byte authentication tag prevents padding oracle and bit-flip attacks
 * that were possible with the previous AES-256-CBC implementation.
 *
 * Wire format: gcm|<24-hex-IV>|<32-hex-tag>|<ciphertext-base64>
 *   - IV  : 12 bytes → 24 hex chars  (96-bit IV, optimal for GCM counter)
 *   - Tag : 16 bytes → 32 hex chars  (128-bit GCM authentication tag)
 *
/**
 * Encrypts a message using AES-256-CBC + HMAC-SHA256 (mac| format).
 * 
 * CRITICAL: We use CBC (mac|) for frontend compatibility.
 * The React Native frontend (CryptoJS) does NOT support GCM.
 * Changing this to GCM will break admin sessions and chat rendering.
 *
 * @param {string} text - Plain text to encrypt
 * @returns {string} Encrypted string with mac| prefix
 */
export const encryptMessage = (text) => {
    return encryptMessageCBC(text);
};

/**
 * Decrypts a message produced by encryptMessage.
 *
 * Supports three formats for backward compatibility:
 *   1. gcm|<iv-hex>|<tag-hex>|<ciphertext-b64>  ← new GCM (preferred)
 *   2. <32-hex-iv>|<ciphertext-b64>              ← legacy CBC with pipe delimiter
 *   3. <hex-iv>:<ciphertext-b64>                 ← legacy CBC with colon delimiter
 *
 * SECURITY NOTE: All decrypt failures return the raw input — no differentiated
 * error messages that could leak oracle information to an attacker.
 *
 * @param {string} encryptedText - The encrypted string
 * @returns {string} Decrypted plain text, or original input on any failure
 */
export const decryptMessage = (encryptedText) => {
    if (!encryptedText) return "";
    const key = deriveKey();

    try {
        // ── Path 0: Encrypt-then-MAC CBC (mac| format, widget-compatible) ────────
        if (encryptedText.startsWith('mac|')) {
            return decryptMessageCBC(encryptedText);
        }

        // ── Path 1: AES-256-GCM (new format) ────────────────────────────────
        if (encryptedText.startsWith('gcm|')) {
            const parts = encryptedText.split('|');
            // Expected: ['gcm', ivHex, tagHex, ciphertextBase64]
            if (parts.length !== 4) return encryptedText;

            const [, ivHex, tagHex, cipherTextBase64] = parts;

            if (!ivHex || ivHex.length !== 24 || !tagHex || tagHex.length !== 32 || !cipherTextBase64) {
                return encryptedText;
            }

            const iv = Buffer.from(ivHex, 'hex');
            const tag = Buffer.from(tagHex, 'hex');

            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag); // Authenticate BEFORE decrypting

            let decrypted = decipher.update(cipherTextBase64, 'base64', 'utf8');
            decrypted += decipher.final('utf8'); // Throws if tag is invalid

            return decrypted;
        }

        // ── Path 2: Legacy AES-256-CBC with pipe delimiter ────────────────────
        if (encryptedText.includes('|')) {
            const pipeIdx = encryptedText.indexOf('|');
            const ivHex = encryptedText.slice(0, pipeIdx);
            const cipherTextBase64 = encryptedText.slice(pipeIdx + 1);

            if (!ivHex || ivHex.length !== 32 || !cipherTextBase64) return encryptedText;

            const iv = Buffer.from(ivHex, 'hex');
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            let decrypted = decipher.update(cipherTextBase64, 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        }

        // ── Path 3: Legacy AES-256-CBC with colon delimiter ───────────────────
        if (encryptedText.includes(':')) {
            const colonIdx = encryptedText.indexOf(':');
            const ivHex = encryptedText.slice(0, colonIdx);
            const cipherTextBase64 = encryptedText.slice(colonIdx + 1);

            if (!ivHex || !cipherTextBase64) return encryptedText;

            const iv = Buffer.from(ivHex, 'hex');
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            let decrypted = decipher.update(cipherTextBase64, 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        }

        // Not an encrypted string — return as-is
        return encryptedText;
    } catch {
        // Uniform error — same response for all failures (prevents oracle leakage)
        return encryptedText;
    }
};

/**
 * Decrypts a mac| (Encrypt-then-MAC CBC) token.
 * Verifies HMAC BEFORE decrypting — padding oracle closed.
 * Returns plaintext string, or the original encryptedText on any failure.
 * @param {string} encryptedText - mac|iv|hmac|ciphertext
 */
const decryptMessageCBC = (encryptedText) => {
    try {
        const parts = encryptedText.split('|');
        // Format: mac|<ivHex>|<hmacHex>|<ciphertextB64>
        if (parts.length !== 4 || parts[0] !== 'mac') return encryptedText;
        const [, ivHex, receivedHmac, ciphertext] = parts;

        // 1. Verify HMAC FIRST — reject immediately if tampered
        const macKey = deriveHMACKey();
        const expectedHmac = crypto.createHmac('sha256', macKey)
            .update(`${ivHex}|${ciphertext}`)
            .digest('hex');

        // Constant-time comparison to prevent timing attacks
        if (!crypto.timingSafeEqual(
            Buffer.from(receivedHmac, 'hex'),
            Buffer.from(expectedHmac, 'hex')
        )) {
            return encryptedText; // HMAC failed — do NOT decrypt
        }

        // 2. HMAC passed — safe to decrypt
        const iv = Buffer.from(ivHex, 'hex');
        const encKey = deriveKey();
        const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
        let plain = decipher.update(ciphertext, 'base64', 'utf8');
        plain += decipher.final('utf8');
        return plain;
    } catch {
        return encryptedText;
    }
};


/**
 * Encrypts using AES-256-CBC + HMAC-SHA256 (Encrypt-then-MAC).
 * Used for all socket emissions to widget clients (must be synchronously decryptable).
 *
 * Format: mac|<32-hex-IV>|<64-hex-HMAC>|<ciphertext-base64>
 *
 * The HMAC covers IV + ciphertext, so the server (and widget) verifies integrity
 * BEFORE attempting decryption — this fully closes the padding oracle attack surface.
 */
export const encryptMessageCBC = (text) => {
    if (!text) return "";
    try {
        const iv = crypto.randomBytes(16);
        const encKey = deriveKey();
        const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
        let ciphertext = cipher.update(text, 'utf8', 'base64');
        ciphertext += cipher.final('base64');

        const ivHex = iv.toString('hex');
        const macKey = deriveHMACKey();
        const hmac = crypto.createHmac('sha256', macKey)
            .update(`${ivHex}|${ciphertext}`)
            .digest('hex');

        return `mac|${ivHex}|${hmac}|${ciphertext}`;
    } catch (error) {
        console.error("CBC Encryption failed:", error);
        return text;
    }
};
