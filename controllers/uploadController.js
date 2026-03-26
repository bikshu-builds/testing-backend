import { Upload } from "@aws-sdk/lib-storage";
import s3Client from "../config/s3.js";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { validateFileType } from "../utils/fileTypeValidator.js";

/**
 * Upload file to S3
 * POST /api/upload
 */
export const uploadFile = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "No file uploaded",
            });
        }

        const file = req.file;

        // ── Magic byte validation ──────────────────────────────────────────────
        // The client-supplied Content-Type header (file.mimetype) is fully
        // attacker-controlled and cannot be trusted. We inspect the actual bytes
        // of the buffer to verify the file truly is an allowed image format.
        const { valid, detectedType } = validateFileType(file.buffer);
        if (!valid) {
            return res.status(400).json({
                success: false,
                message: "File content does not match an allowed image type. Only JPEG, PNG, GIF, and WebP files are accepted.",
            });
        }
        // ──────────────────────────────────────────────────────────────────────

        const fileExtension = path.extname(file.originalname);
        const fileName = `${uuidv4()}${fileExtension}`;
        const key = `uploads/${fileName}`;

        const upload = new Upload({
            client: s3Client,
            params: {
                Bucket: process.env.AWS_S3_BUCKET,
                Key: key,
                Body: file.buffer,
                // Use the SERVER-VERIFIED type, not the client-supplied one
                ContentType: detectedType,
                Metadata: {
                    originalName: encodeURIComponent(file.originalname),
                    uploadedAt: new Date().toISOString(),
                },
            },
        });

        const result = await upload.done();

        // Construct public URL (assuming public bucket or handling signed URL separately)
        // If the bucket is public:
        const fileUrl = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

        return res.status(200).json({
            success: true,
            message: "File uploaded successfully",
            fileUrl,
            fileName: req.file.originalname,
            fileKey: key,
        });

    } catch (error) {
        console.error("Upload error:", error);

        // Handle specific AWS errors
        let errorMessage = "File upload failed";
        if (error.name === 'NoSuchBucket') {
            errorMessage = "S3 bucket not found. Please check AWS_S3_BUCKET configuration.";
        } else if (error.name === 'InvalidAccessKeyId') {
            errorMessage = "Invalid AWS credentials. Please check AWS_ACCESS_KEY_ID.";
        } else if (error.name === 'SignatureDoesNotMatch') {
            errorMessage = "Invalid AWS secret key. Please check AWS_SECRET_ACCESS_KEY.";
        }

        return res.status(500).json({
            success: false,
            message: errorMessage,
        });
    }
};
