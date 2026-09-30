import { v2 as cloudinary } from "cloudinary";
import cookieParser from "cookie-parser";
import cors from "cors";
import { config as envConfig } from "dotenv";
import express from "express";
import { createServer } from "http";
import morgan from "morgan";
import { Server } from "socket.io";
import { v4 as uuid } from "uuid";
import { isSocketAuthenticated } from "./middlewares/auth.js";
import { errorMiddleware, TryCatch } from "./middlewares/error.js";
import messageModel from "./models/message.models.js";
import chatModel from "./models/chat.models.js";
import adminRouter from "./routes/admin.routes.js";
import chatRouter from "./routes/chat.routes.js";
import userRouter from "./routes/user.routes.js";
import {
  CHAT_JOINED,
  CHAT_LEAVED,
  NEW_MESSAGE,
  NEW_MESSAGE_ALERT,
  ONLINE_USERS,
  START_TYPING,
  STOP_TYPING,
} from "./utils/events.js";
import { connectDB, getSockets } from "./utils/features.js";

envConfig({
  path: "./.env",
});

const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV.trim() || "production";
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || "Admin@1234";
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const JWT_COOKIE_EXPIRES_IN = process.env.JWT_COOKIE_EXPIRES_IN || "7";
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLIENT_URL = process.env.CLIENT_URL;
const CLIENT_PRODUCTION_URL = process.env.CLIENT_PRODUCTION_URL;
const STEALTHY_NOTE_TOKEN_NAME = process.env.STEALTHY_NOTE_TOKEN_NAME;
const STEALTHY_NOTE_ADMIN_TOKEN_NAME =
  process.env.STEALTHY_NOTE_ADMIN_TOKEN_NAME;

if (!JWT_SECRET) {
  console.error("JWT Secret is not defined in the environment variables.");
  process.exit(1);
}

if (!ADMIN_SECRET_KEY) {
  console.error(
    "Admin Secret Key is not defined in the environment variables."
  );
  process.exit(1);
}

if (!NODE_ENV) {
  console.error(
    "Node Environment is not defined in the environment variables."
  );
  process.exit(1);
}

if (!PORT) {
  console.error("Port is not defined in the environment variables.");
  process.exit(1);
}

if (!JWT_EXPIRES_IN) {
  console.error("JWT Expires In is not defined in the environment variables.");
  process.exit(1);
}

if (!MONGODB_URI) {
  console.error("MongoDB URI is not defined in the environment variables.");
  process.exit(1);
}

if (!CLOUDINARY_CLOUD_NAME) {
  console.error(
    "Cloudinary Cloud Name is not defined in the environment variables."
  );
  process.exit(1);
}

if (!CLOUDINARY_API_KEY) {
  console.error(
    "Cloudinary API Key is not defined in the environment variables."
  );
  process.exit(1);
}

if (!CLOUDINARY_API_SECRET) {
  console.error(
    "Cloudinary API Secret is not defined in the environment variables."
  );
  process.exit(1);
}

if (!CLIENT_URL) {
  console.error("Client URL is not defined in the environment variables.");
  process.exit(1);
}

if (!CLIENT_PRODUCTION_URL) {
  console.error(
    "Client Production URL is not defined in the environment variables."
  );
  process.exit(1);
}

if (process.env.NODE_ENV !== 'test') {
  connectDB(MONGODB_URI);
}

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
});

const cookieOptions = {
  maxAge: JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000,
  httpOnly: true,
  secure: process.env.NODE_ENV.trim() === "production" ? true : false,
  sameSite: process.env.NODE_ENV.trim() === "production" ? "none" : "lax",
};

const corsOptions = {
  origin: [CLIENT_URL, CLIENT_PRODUCTION_URL],
  credentials: true,
};

const app = express();
const server = createServer(app);

const io = new Server(server, { cors: corsOptions });
app.use(cors(corsOptions));

app.set("io", io);

app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));

if (NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.get("/", (req, res) => {
  res.send(
    `<h1>
      <center>Welcome to the Home Page</center>
    </h1>`
  );
});

app.use("/api/v1/user", userRouter);
app.use("/api/v1/chat", chatRouter);
app.use("/api/v1/admin", adminRouter);

const userSocketIDs = new Map();
const onlineUsers = new Set();

io.use((socket, next) => {
  cookieParser()(
    socket.request,
    socket.request.res,
    async (err) => await isSocketAuthenticated(err, socket, next)
  );
});

io.on(
  "connection",
  TryCatch((socket) => {
    const user = socket.user;

    const userId = user._id.toString();
    const sockets = userSocketIDs.get(userId) || new Set();
    sockets.add(socket.id);
    userSocketIDs.set(userId, sockets);

    socket.on(NEW_MESSAGE, async ({ chatId, message, members, replyTo }) => {
      const chat = await chatModel.findById(chatId).select("members").lean();
      if (!chat || !chat.members.some((member) => member.toString() === userId)) {
        return socket.emit("error", "You are not a member of this chat");
      }
      const authorizedMembers = chat.members.map((member) => member.toString());
      const messageForRealTime = {
        _id: uuid(),
        attachments: [],
        content: message,
        replyTo: replyTo
          ? {
              senderName: replyTo.senderName || "",
              content: replyTo.content || "",
            }
          : undefined,
        sender: {
          _id: user._id,
          name: user.name,
        },
        chat: chatId,
        createdAt: new Date().toISOString(),
      };

      const messageForDB = {
        content: message,
        chat: chatId,
        sender: user._id,
        attachments: [],
        replyTo: replyTo
          ? {
              senderName: replyTo.senderName || "",
              content: replyTo.content || "",
            }
          : undefined,
      };

      const membersSocket = getSockets(authorizedMembers);

      io.to(membersSocket).emit(NEW_MESSAGE, {
        chatId,
        message: messageForRealTime,
      });

      io.to(membersSocket).emit(NEW_MESSAGE_ALERT, {
        chatId,
      });

      messageModel.create(messageForDB);
    });

    socket.on(START_TYPING, ({ chatId, members, senderId }) => {
      const membersSocket = getSockets(members);
      socket.to(membersSocket).emit(START_TYPING, {
        chatId,
        senderId,
      });
    });

    socket.on(STOP_TYPING, ({ chatId, members, senderId }) => {
      const membersSocket = getSockets(members);
      socket.to(membersSocket).emit(STOP_TYPING, {
        chatId,
        senderId,
      });
    });

    socket.on(CHAT_JOINED, ({ chatId, userId, members }) => {
      onlineUsers.add(userId.toString());
      const membersSocket = getSockets(members);
      io.to(membersSocket).emit(ONLINE_USERS, {
        onlineUsers: Array.from(onlineUsers),
        chatId,
      });
    });

    socket.on(CHAT_LEAVED, ({ chatId, userId, members }) => {
      onlineUsers.delete(userId.toString());
      const membersSocket = getSockets(members);
      io.to(membersSocket).emit(ONLINE_USERS, {
        onlineUsers: Array.from(onlineUsers),
        chatId,
      });
    });

    socket.on("disconnect", () => {
      const sockets = userSocketIDs.get(userId);
      sockets?.delete(socket.id);
      if (!sockets?.size) userSocketIDs.delete(userId);
      onlineUsers.delete(user._id.toString());
      socket.broadcast.emit(ONLINE_USERS, {
        onlineUsers: Array.from(onlineUsers),
      });
    });
  })
);

app.use(errorMiddleware);

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT} in ${NODE_ENV} mode`);
  });
}

// createUser(20);
// createMessageInChat("681705f74b713bef198acf99", 50);
// createSingleChat(100);
// createGroupChat(27);
// createMessages(3256);

export {
  ADMIN_SECRET_KEY,
  cookieOptions,
  JWT_COOKIE_EXPIRES_IN,
  JWT_EXPIRES_IN,
  JWT_SECRET,
  NODE_ENV,
  STEALTHY_NOTE_ADMIN_TOKEN_NAME,
  STEALTHY_NOTE_TOKEN_NAME,
  userSocketIDs,
};

export default app;
