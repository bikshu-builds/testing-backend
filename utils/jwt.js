import { EncryptJWT, jwtDecrypt } from "jose";
import crypto from "crypto";

// ─── Encryption Key ──────────────────────────────────────────────────────────
// Must be a 256-bit (32-byte) random key stored in JWE_ENCRYPTION_KEY env var.
// Generate with: node -e ".randomBytes(32).toString('hex'))"
const rawKey = process.env.JWE_ENCRYPTION_KEY;

if (!rawKey) {
  throw new Error(
    "JWE_ENCRYPTION_KEY is not set. " +
    "Generate one with: node -e \".randomBytes(32).toString('hex'))\""
  );
}

// Decode hex key → 32-byte Uint8Array (required by jose)
const ENCRYPTION_KEY = new Uint8Array(Buffer.from(rawKey, "hex"));

if (ENCRYPTION_KEY.length !== 32) {
  throw new Error(
    "JWE_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters). " +
    `Got ${ENCRYPTION_KEY.length} bytes.`
  );
}

// ─── JWE Token Generation ─────────────────────────────────────────────────────
/**
 * Issues a JWE (JSON Web Encryption) token.
 * Algorithm : dir (direct key agreement — no key wrapping overhead)
 * Encryption : A256GCM (AES-256-GCM — AEAD: confidentiality + integrity + authenticity)
 *
 * The resulting compact token is 5 dot-separated Base64url segments.
 * The payload segment is pure ciphertext — decoding reveals no readable JSON.
 *
 * @param {object} payload - Claims to encrypt (e.g. { adminId, email, role })
 * @param {string} [expiresIn="7d"] - Expiry duration (e.g. "15m", "8h", "7d")
 * @returns {Promise<string>} JWE compact serialisation string
 */
export const generateJWE = async (payload, expiresIn = "7d") => {
  const now = Math.floor(Date.now() / 1000);
  const expSeconds = parseExpiry(expiresIn);

  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt(now)
    .setExpirationTime(now + expSeconds)
    .encrypt(ENCRYPTION_KEY);
};

/**
 * Generate a JWE for students
 * @param {object} payload - Claims to encrypt
 * @returns {Promise<string>} JWE compact serialisation string
 */
export const generateStudentJWE = async (payload) => {
  try {
    const secret = new Uint8Array(
      crypto.createHash('sha256')
        .update(process.env.STUDENT_JWE_ENCRYPTION_KEY)
        .digest()
    );

    const now = Math.floor(Date.now() / 1000);
    const expSeconds = 24 * 3600; // 24 hours for student sessions

    return new EncryptJWT(payload)
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuedAt(now)
      .setExpirationTime(now + expSeconds)
      .encrypt(secret);
  } catch (error) {
    console.error("generateStudentJWE error:", error);
    throw new Error("Failed to generate student session");
  }
};

/**
 * Verify and decrypt a student JWE
 * @param {string} token - JWE compact serialisation string
 * @returns {Promise<object>} Decrypted payload claims
 */
export const verifyStudentJWE = async (token) => {
  try {
    const secret = new Uint8Array(
      crypto.createHash('sha256')
        .update(process.env.STUDENT_JWE_ENCRYPTION_KEY)
        .digest()
    );

    const { payload } = await jwtDecrypt(token, secret, {
      clockTolerance: 0,
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    return payload;
  } catch (error) {
    // console.error("verifyStudentJWE error:", error);
    throw new Error("Invalid or expired student session");
  }
};

// ─── JWE Token Verification ───────────────────────────────────────────────────
/**
 * Decrypts and verifies a JWE compact token.
 * - Verifies the GCM authentication tag (integrity + authenticity)
 * - Verifies the exp claim (expiry)
 *
 * @param {string} token - JWE compact serialisation string
 * @returns {Promise<object>} Decrypted payload claims
 * @throws If decryption fails, tag is invalid, or token is expired
 */
export const verifyJWE = async (token) => {
  const { payload } = await jwtDecrypt(token, ENCRYPTION_KEY, {
    clockTolerance: 0,
    keyManagementAlgorithms: ["dir"],
    contentEncryptionAlgorithms: ["A256GCM"],
  });
  return payload;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Parses a duration string like "15m", "8h", "7d" into seconds.
 */
function parseExpiry(str) {
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid expiry format: "${str}". Use e.g. "15m", "8h", "7d".`);
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * multipliers[unit];
}

// ─── Legacy export (kept for widget/chatHandlers.js compatibility) ─────────────
// The widget student session uses a separate mechanism in chatHandlers.js.
// This export is intentionally left as a no-op alias to avoid import errors
// in any file that still references generateToken.
export const generateToken = (admin) => {
  throw new Error(
    "generateToken (JWS) has been replaced by generateJWE. " +
    "Use: await generateJWE({ adminId: admin._id, email: admin.email, role: admin.role })"
  );
};
