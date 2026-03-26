/**
 * fileTypeValidator.js
 *
 * Validates uploaded file buffers using "magic byte" (file signature) inspection.
 * This is the authoritative server-side check — it is NOT affected by the
 * Content-Type header the client sends, which is fully attacker-controllable.
 *
 * Supported types: JPEG, PNG, GIF, WebP
 */

const MAGIC_BYTES = [
    {
        mimeType: 'image/jpeg',
        // JPEG files start with FF D8 FF
        check: (buf) =>
            buf.length >= 3 &&
            buf[0] === 0xff &&
            buf[1] === 0xd8 &&
            buf[2] === 0xff,
    },
    {
        mimeType: 'image/png',
        // PNG files start with 89 50 4E 47 0D 0A 1A 0A
        check: (buf) =>
            buf.length >= 8 &&
            buf[0] === 0x89 &&
            buf[1] === 0x50 && // P
            buf[2] === 0x4e && // N
            buf[3] === 0x47 && // G
            buf[4] === 0x0d &&
            buf[5] === 0x0a &&
            buf[6] === 0x1a &&
            buf[7] === 0x0a,
    },
    {
        mimeType: 'image/gif',
        // GIF files start with "GIF8" (47 49 46 38)
        check: (buf) =>
            buf.length >= 4 &&
            buf[0] === 0x47 && // G
            buf[1] === 0x49 && // I
            buf[2] === 0x46 && // F
            buf[3] === 0x38,   // 8
    },
    {
        mimeType: 'image/webp',
        // WebP: bytes 0-3 are "RIFF" (52 49 46 46),
        //       bytes 8-11 are "WEBP" (57 45 42 50)
        check: (buf) =>
            buf.length >= 12 &&
            buf[0] === 0x52 && // R
            buf[1] === 0x49 && // I
            buf[2] === 0x46 && // F
            buf[3] === 0x46 && // F
            buf[8] === 0x57 && // W
            buf[9] === 0x45 && // E
            buf[10] === 0x42 && // B
            buf[11] === 0x50,   // P
    },
];

/**
 * Inspect the raw bytes of a file buffer to determine its true type.
 *
 * @param {Buffer} buffer - The file buffer (from multer memoryStorage)
 * @returns {{ valid: boolean, detectedType: string | null }}
 *   valid        – true if the buffer matches a known allowed image signature
 *   detectedType – the server-verified MIME type string, or null if unrecognised
 */
export function validateFileType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        return { valid: false, detectedType: null };
    }

    for (const { mimeType, check } of MAGIC_BYTES) {
        if (check(buffer)) {
            return { valid: true, detectedType: mimeType };
        }
    }

    return { valid: false, detectedType: null };
}
