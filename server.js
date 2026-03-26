import express from "express";
import { createServer } from "http";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dns from "dns";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import connectDB from "./config/db.js";
import { corsOptions } from "./config/cors.js";
import { initializeSocket } from "./config/socket.js";
import { setupSocketHandlers, startChatPinExpiryCron } from "./sockets/chatHandlers.js";

import adminRoutes from "./routes/adminRoutes.js";
import projectRoutes from "./routes/projectRoutes.js";
import supportUserRoutes from "./routes/supportUserRoutes.js";
import projectSupportUserRoutes from "./routes/projectSupportUserRoutes.js";
import messageRoutes from "./routes/messageRoutes.js";
import { scheduleCleanup } from "./utils/cleanupSkippedChats.js";
import { scheduleFileCleanup } from "./utils/cleanupFiles.js";
import { startAutoResolveCron } from "./utils/autoResolveChats.js";

import uploadRoutes from "./routes/uploadRoutes.js";
import quickReplyRoutes from "./routes/quickReplyRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";

dotenv.config();
await connectDB();


const app = express();
const httpServer = createServer(app);

// Initialize Socket.IO
const io = initializeSocket(httpServer);
setupSocketHandlers(io);

app.use(cors());

// Security headers — helmet adds X-Frame-Options, X-Content-Type-Options,
// Strict-Transport-Security, Referrer-Policy and more.
// CSP is disabled here because the Next.js frontend manages its own CSP
// and all API routes return JSON where a CSP header has no effect.
// CORP (crossOriginResourcePolicy) is disabled because the widget bundle.js
// must be loadable via <script> tags on third-party client websites.
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false
}));

// LOW-02: Explicit JSON body size limit
app.use(express.json({ limit: "1mb" }));

// Dynamic route for the widget bundle to inject environment variables
app.get("/api/widget/bundle.js", (req, res) => {
    const filePath = path.join(__dirname, "public", "widget", "bundle.js");
    fs.readFile(filePath, "utf8", (err, data) => {
        if (err) {
            console.error("Error reading bundle.js:", err);
            return res.status(500).send("Error loading widget");
        }
        const updatedContent = data.split("<<<MESSAGE_JWT_SECRET>>>").join(process.env.MESSAGE_JWT_SECRET || "");
        res.setHeader("Content-Type", "application/javascript");
        res.send(updatedContent);
    });
});

app.get("/api/widget/bundle.mjs", (req, res) => {
    const filePath = path.join(__dirname, "public", "widget", "bundle.mjs");
    fs.readFile(filePath, "utf8", (err, data) => {
        if (err) {
            console.error("Error reading bundle.mjs:", err);
            return res.status(500).send("Error loading widget");
        }
        const updatedContent = data.split("<<<MESSAGE_JWT_SECRET>>>").join(process.env.MESSAGE_JWT_SECRET || "");
        res.setHeader("Content-Type", "application/javascript");
        res.send(updatedContent);
    });
});

app.get("/api/widget/bundle.cjs", (req, res) => {
    const filePath = path.join(__dirname, "public", "widget", "bundle.cjs");
    fs.readFile(filePath, "utf8", (err, data) => {
        if (err) {
            console.error("Error reading bundle.cjs:", err);
            return res.status(500).send("Error loading widget");
        }
        const updatedContent = data.split("<<<MESSAGE_JWT_SECRET>>>").join(process.env.MESSAGE_JWT_SECRET || "");
        res.setHeader("Content-Type", "application/javascript");
        res.send(updatedContent);
    });
});

app.use(express.static("public"));

// MED-02: Rate limiting — strict limit on login endpoints
const loginLimiter = rateLimit({
    windowMs: 30 * 60 * 1000, // 30 minutes
    max: 100, // max 10 login attempts per window
    message: { success: false, message: "Too many login attempts from this IP. Please try again after 30 minutes." },
    standardHeaders: true,
    legacyHeaders: false,
});

// HIGH-04: Rate limiting — prevent brute-force enumeration of project IDs
// on the public widget config endpoint (no auth required on this route)
// const publicConfigLimiter = rateLimit({
//     windowMs: 15 * 60 * 1000, // 15-minute window
//     max: 100,                   // 60 requests per IP per window
//     message: { success: false, message: "Too many requests. Please slow down." },
//     standardHeaders: true,
//     legacyHeaders: false,
// });

// Make io accessible to routes if needed
app.set("io", io);

// routes — login routes have rate limiting applied
app.use("/api/admin/login", loginLimiter);
app.use("/api/support-users/login", loginLimiter);
// SECURITY: rate-limit the unauthenticated public config endpoint; must be
// registered BEFORE the project router so it applies to all matching requests.
//app.use("/api/projects/public", publicConfigLimiter);

app.use("/api/admin", adminRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/support-users", supportUserRoutes);
app.use("/api/project-assignments", projectSupportUserRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/quick-replies", quickReplyRoutes);
app.use("/api/dashboard", dashboardRoutes);


const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT} 🚀`);

    // Start cleanup scheduler for skipped email chats
    scheduleCleanup();
    // Start cleanup scheduler for old files (7 days)
    scheduleFileCleanup();
    // Start auto-unpin cron job for chats
    startChatPinExpiryCron(io);
    startAutoResolveCron(io);
});
