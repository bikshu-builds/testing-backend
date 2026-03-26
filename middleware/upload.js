import multer from "multer";

// Use memory storage to process file before upload (e.g. check type, size)
const storage = multer.memoryStorage();

// Limit file size to 5MB
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'image/jpeg',
            'image/png',
            'image/gif',
            'image/webp'
        ];

        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Only images are allowed"), false);
        }
    },
});

export default upload;
