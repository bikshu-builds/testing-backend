import { GetObjectCommand } from "@aws-sdk/client-s3";
import s3Client from "../config/s3.js";

/**
 * Fetches an S3 object by URL and returns it as a Base64 Data URI.
 * Used to serve S3-hosted images directly in API responses, bypassing
 * browser CORS issues with private S3 bucket URLs.
 *
 * @param {string} url - Full S3 URL (e.g. https://bucket.s3.region.amazonaws.com/key)
 * @returns {Promise<string>} Base64 Data URI or the original URL if fetch fails
 */
export const getFileAsBase64 = async (url) => {
    if (!url || typeof url !== "string" || !url.includes("amazonaws.com")) return url;
    try {
        const parts = url.split(".amazonaws.com/");
        if (parts.length < 2) return url;
        const key = parts[1];

        const command = new GetObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET,
            Key: key,
        });

        const response = await s3Client.send(command);
        const stream = response.Body;

        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        const mimeType = response.ContentType || "image/png";

        return `data:${mimeType};base64,${buffer.toString("base64")}`;
    } catch (e) {
        console.error("[s3Helper] Failed to fetch file as Base64:", e.message);
        return url; // Fallback to URL if fetch fails
    }
};
