import { Server } from "socket.io";

export const initializeSocket = (server) => {
    const io = new Server(server, {
        cors: {
            origin: "*", // allow any origin so the widget can be embedded anywhere
            methods: ["GET", "POST"],
        },
        pingTimeout: 60000, // 60 seconds
        pingInterval: 25000, // 25 seconds
    });

    console.log("Socket.IO initialized and ready ✅");

    return io;
};
