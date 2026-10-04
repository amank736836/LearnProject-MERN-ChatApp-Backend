import { google } from "@ai-sdk/google";
import { streamText } from "ai";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import { JWT_SECRET, STEALTHY_NOTE_TOKEN_NAME } from "../app.js";
import { ErrorHandler, TryCatch } from "../middlewares/error.js";
import chatModel from "../models/chat.models.js";
import messageModel from "../models/message.models.js";
import requestModel from "../models/request.models.js";
import suggestedQuestionModel from "../models/suggestedQuestion.models.js";
import userModel from "../models/user.models.js";
import {
  ALERT,
  NEW_MESSAGE,
  NEW_MESSAGE_ALERT,
  NEW_REQUEST,
  QUESTION_ASKED,
  REFETCH_CHATS,
} from "../utils/events.js";
import {
  deleteFilesFromCloudinary,
  emitEvent,
  getSockets,
  uploadFilesToCloudinary,
} from "../utils/features.js";
import { markBoardQuestionAnswered, resolveAskHost } from "../utils/boardAnswers.js";
import { askNvidiaWithContext } from "../utils/nvidiaAI.js";

const getTokenUserId = (decodedData) => decodedData?.id || decodedData?._id;

const resolveSenderFromCookie = async (req) => {
  try {
    const token = req?.cookies?.[STEALTHY_NOTE_TOKEN_NAME];

    if (!token) return null;

    const decodedData = jwt.verify(token, JWT_SECRET);
    const senderId = getTokenUserId(decodedData);

    if (!senderId) return null;

    const sender = await userModel.findById(senderId).select("_id name username").lean();

    return sender || null;
  } catch {
    return null;
  }
};

const newGroupChat = TryCatch(async (req, res, next) => {
  const { name, otherMembers } = req.body;

  if (!name) return next(new ErrorHandler("Group name is required", 400));

  if (!otherMembers || otherMembers.length === 0)
    return next(new ErrorHandler("Group members are required", 400));

  const members = [...otherMembers, req.userId];

  const chat = await chatModel.create({
    name,
    members,
    groupChat: true,
    creator: req.userId,
  });

  emitEvent(req, ALERT, members, {
    chatId: chat._id,
    message: `Welcome to ${name} group chat`,
  });

  emitEvent(req, REFETCH_CHATS, otherMembers);

  messageModel.create({
    chat: chat._id,
    content: `Welcome to ${name} group chat`,
    sender: req.userId,
  });

  return res.status(201).json({
    success: true,
    message: "Group chat created successfully",
  });
});

const getMyChats = TryCatch(async (req, res, next) => {
  if (!req.userId)
    return next(new ErrorHandler("Login to access this resource", 401));

  const chats = await chatModel
    .find({ members: req.userId })
    .populate("members", "name avatar")
    .sort({ updatedAt: -1 });

  const transformedChats = chats.map(({ _id, name, members, groupChat }) => {
    let otherMember = null;
    if (String(_id) !== String(req.userId)) {
      otherMember = members.find(
        (member) => member._id.toString() !== req.userId
      );
    } else {
      otherMember = members[0];
    }

    return {
      _id,
      name: groupChat
        ? name
        : otherMember?.name || "Anonymous Inbox",
      groupChat,
      avatar: groupChat
        ? members.slice(0, 3).map(({ avatar }) => avatar.url)
        : [otherMember?.avatar?.url || ""],
      members: members.reduce((acc, member) => {
        if (member._id.toString() !== req.userId) {
          acc.push(member._id);
        }
        return acc;
      }, []),
    };
  });

  return res.status(200).json({
    success: true,
    message: "Chats fetched successfully",
    chats: transformedChats,
  });
});

const getMyGroups = TryCatch(async (req, res, next) => {
  if (!req.userId)
    return next(new ErrorHandler("Login to access this resource", 401));

  const chats = await chatModel
    .find({
      members: req.userId,
      groupChat: true,
      creator: req.userId,
    })
    .populate("members", "name avatar")
    .sort({ updatedAt: -1 });

  const groups = chats.map(({ _id, name, groupChat, members }) => ({
    _id,
    name,
    groupChat,
    avatar: members.slice(0, 3).map(({ avatar }) => avatar.url),
    members: members.map(({ _id }) => _id),
  }));

  return res.status(200).json({
    success: true,
    message: "Groups fetched successfully",
    groups,
  });
});

const addGroupMembers = TryCatch(async (req, res, next) => {
  const { chatId, members } = req.body;

  if (!chatId) {
    return next(new ErrorHandler("Chat ID is required", 400));
  }

  if (!members) {
    return next(new ErrorHandler("Members are required", 400));
  }

  if (members.length < 1) {
    return next(new ErrorHandler("At least one member is required", 400));
  }

  const chat = await chatModel.findById(chatId);

  if (!chat) {
    return next(new ErrorHandler("Chat not found", 404));
  }

  if (!chat.groupChat) {
    return next(new ErrorHandler("Not a group chat", 400));
  }

  if (chat.creator.toString() !== req.userId.toString()) {
    return next(new ErrorHandler(`Only creator can add members`, 403));
  }

  const allNewMembersPromise = members.map((member) =>
    userModel.findById(member, "name")
  );

  const allNewMembers = await Promise.all(allNewMembersPromise);

  const uniqueMembers = allNewMembers.map(({ _id }) => _id);

  if (uniqueMembers.length < 1) {
    return next(
      new ErrorHandler(
        "Please select members that are not already in the group",
        400
      )
    );
  }

  chat.members.push(...uniqueMembers);

  if (chat.members.length > 100) {
    return next(new ErrorHandler("Group chat can have max 100 members", 400));
  }

  await chat.save();

  const allUsersName = allNewMembers.map(({ name }) => name).join(",");

  emitEvent(req, ALERT, chat.members, {
    chatId,
    message: `${allUsersName} has been added in the group`,
  });

  messageModel.create({
    chat: chatId,
    content: `${allUsersName} has been added in the group`,
    sender: req.userId,
  });

  emitEvent(req, REFETCH_CHATS, uniqueMembers);

  return res.status(200).json({
    success: true,
    message: "Members added successfully",
  });
});

const removeMember = TryCatch(async (req, res, next) => {
  const { chatId, memberId } = req.body;

  if (!chatId) {
    return next(new ErrorHandler("Chat ID is required", 400));
  }

  if (!memberId) {
    return next(new ErrorHandler("Member ID is required", 400));
  }

  const [chat, userThatWillBeRemoved] = await Promise.all([
    chatModel.findById(chatId),
    userModel.findById(memberId, "name"),
  ]);

  if (!chat) {
    return next(new ErrorHandler("Chat not found", 404));
  }

  if (!userThatWillBeRemoved) {
    return next(new ErrorHandler("User not found", 404));
  }

  if (!chat.groupChat) {
    return next(new ErrorHandler("Not a group chat", 400));
  }

  if (chat.creator.toString() !== req.userId.toString()) {
    return next(new ErrorHandler(`Only creator can remove members`, 403));
  }

  if (!chat.members.includes(memberId)) {
    return next(new ErrorHandler("User not in the group", 400));
  }

  if (chat.members.length < 2) {
    return next(
      new ErrorHandler("Group chat must have at least 1 members", 400)
    );
  }

  chat.members = chat.members.filter(
    (member) => member.toString() !== memberId.toString()
  );

  await chat.save();

  emitEvent(req, ALERT, chat.members, {
    chatId,
    message: `User ${userThatWillBeRemoved.name} has been removed from the group`,
  });

  emitEvent(req, REFETCH_CHATS, [memberId]);

  messageModel.create({
    chat: chatId,
    content: `User ${userThatWillBeRemoved.name} has been removed from the group`,
    sender: req.userId,
  });

  return res.status(200).json({
    success: true,
    message: "Member removed successfully",
  });
});

const leaveGroup = TryCatch(async (req, res, next) => {
  const { chatId } = req.body;

  if (!chatId) {
    return next(new ErrorHandler("Chat ID is required", 400));
  }

  const chat = await chatModel.findById(chatId);

  if (!chat) {
    return next(new ErrorHandler("Chat not found", 404));
  }

  if (!chat.groupChat) {
    return next(new ErrorHandler("Not a group chat", 400));
  }

  if (!chat.members.includes(req.userId)) {
    return next(new ErrorHandler("User not in the group", 400));
  }

  const otherMembers = chat.members.filter(
    (member) => member.toString() !== req.userId.toString()
  );
  chat.members = otherMembers;

  if (chat.creator.toString() === req.userId.toString()) {
    const randomCreator = Math.floor(Math.random() * otherMembers.length);
    chat.creator = otherMembers[randomCreator] || "";
  }
  const [user] = await Promise.all([
    userModel.findById(req.userId, "name"),
    chat.save(),
  ]);

  emitEvent(req, ALERT, otherMembers, {
    chatId,
    message: `${user.name}, I am leaving the group`,
  });

  messageModel.create({
    chat: chatId,
    content: `${user.name}, I am leaving the group`,
    sender: req.userId,
  });

  emitEvent(req, REFETCH_CHATS, [req.userId]);

  return res.status(200).json({
    success: true,
    message: "Left group successfully",
  });
});

const sendAttachments = TryCatch(async (req, res, next) => {
  const { chatId } = req.body;

  if (!chatId) {
    return next(new ErrorHandler("Chat ID is required", 400));
  }

  if (!req.userId) {
    return next(new ErrorHandler("Login to access this resource", 401));
  }

  const files = req.files || [];

  if (files.length < 1) {
    return next(new ErrorHandler("Please attach files", 400));
  }

  if (files.length > 5) {
    return next(new ErrorHandler("You can attach max 5 files", 400));
  }

  const [chat, user] = await Promise.all([
    chatModel.findById(chatId),
    userModel.findById(req.userId, "name"),
  ]);

  if (!chat) {
    return next(new ErrorHandler("Chat not found", 404));
  }

  if (!chat.members.includes(req.userId)) {
    return next(new ErrorHandler("User not in the group", 400));
  }

  const attachments = await uploadFilesToCloudinary(files);

  const messageForDB = {
    chat: chatId,
    content: "",
    attachments,
    sender: req.userId,
  };

  const messageForRealTime = {
    ...messageForDB,
    sender: {
      _id: req.userId,
      name: user.name,
    },
    _id: uuid(),
    createdAt: new Date().toISOString(),
  };

  const message = await messageModel.create(messageForDB);

  emitEvent(req, NEW_MESSAGE, chat.members, {
    message: messageForRealTime,
    chatId,
  });

  emitEvent(req, NEW_MESSAGE_ALERT, chat.members, { chatId });

  return res.status(200).json({
    success: true,
    message,
  });
});

const getChatDetails = TryCatch(async (req, res, next) => {
  const { chatId } = req.params;

  if (!chatId) {
    return next(new ErrorHandler("Chat ID is required", 400));
  }

  if (req.query.populate === "true") {
    const chat = await chatModel
      .findById(chatId)
      .populate("members", "name avatar")
      .lean();

    if (!chat) {
      return next(new ErrorHandler("Chat not found", 404));
    }

    chat.members = chat.members.map(({ _id, name, avatar }) => ({
      _id,
      name,
      avatar: avatar.url,
    }));

    return res.status(200).json({
      success: true,
      message: "Chat details fetched successfully with members",
      chat,
    });
  } else {
    const chat = await chatModel.findById(chatId);

    if (!chat) {
      return next(new ErrorHandler("Chat not found", 404));
    }

    return res.status(200).json({
      success: true,
      message: "Chat details fetched successfully",
      chat,
    });
  }
});

const renameGroup = TryCatch(async (req, res, next) => {
  const { chatId } = req.params;
  const { name } = req.body;

  if (!chatId) {
    return next(new ErrorHandler("Chat ID is required", 400));
  }

  if (!name) {
    return next(new ErrorHandler("Group name is required", 400));
  }

  const chat = await chatModel.findById(chatId);

  if (!chat) {
    return next(new ErrorHandler("Chat not found", 404));
  }

  if (!chat.groupChat) {
    return next(new ErrorHandler("Not a group chat", 400));
  }

  if (chat.creator.toString() !== req.userId.toString()) {
    return next(new ErrorHandler(`Only creator can rename group`, 403));
  }

  const previousName = chat.name;
  chat.name = name;

  await chat.save();

  messageModel.create({
    chat: chatId,
    content: `Group name changed from ${previousName} to ${name}`,
    sender: req.userId,
  });

  emitEvent(req, REFETCH_CHATS, chat.members);

  return res.status(200).json({
    success: true,
    message: "Group name changed successfully",
  });
});

const deleteChat = TryCatch(async (req, res, next) => {
  const { chatId } = req.params;

  if (!chatId) {
    return next(new ErrorHandler("Chat ID is required", 400));
  }

  const chat = await chatModel.findById(chatId);

  if (!chat) {
    return next(new ErrorHandler("Chat not found", 404));
  }

  if (chat.groupChat && chat.creator.toString() !== req.userId.toString()) {
    return next(new ErrorHandler(`Only creator can delete group`, 403));
  }

  if (!chat.groupChat && !chat.members.includes(req.userId)) {
    return next(new ErrorHandler(`You are not a member of this chat`, 403));
  }

  const messageWithAttachments = await messageModel.find({
    chat: chatId,
    attachments: { $exists: true, $ne: [] },
  });

  const public_Ids = messageWithAttachments.map((message) =>
    message.attachments.map(({ public_id }) => public_id)
  );

  const members = chat.members;

  await Promise.all([
    deleteFilesFromCloudinary(public_Ids),
    chat.deleteOne(),
    messageModel.deleteMany({ chat: chatId }),
  ]);

  emitEvent(req, REFETCH_CHATS, members);

  return res.status(200).json({
    success: true,
    message: "Chat deleted successfully",
  });
});

const getMessages = TryCatch(async (req, res, next) => {
  const { chatId } = req.params;

  const { page = 1 } = req.query;

  if (!chatId) {
    return next(new ErrorHandler("Chat ID is required", 400));
  }

  const limit = 20;

  const skip = (page - 1) * limit;

  const chat = await chatModel.findById(chatId);

  if (!chat) {
    return next(new ErrorHandler("Chat not found", 404));
  }

  if (!chat.members.includes(req.userId.toString())) {
    return next(new ErrorHandler("User not in the chat", 400));
  }

  const visibilityFilter = {
    chat: chatId,
    $or: [{ privateTo: null }, { privateTo: req.userId }],
  };

  const [messages, totalMessagesCount] = await Promise.all([
    messageModel
      .find(visibilityFilter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .populate("sender", "name")
      .lean(),
    messageModel.countDocuments(visibilityFilter),
  ]);

  if (!chat.groupChat && chat.members.length === 1) {
    messages.forEach((message) => {
      const hasLegacyAnonymousShape =
        message?.isAnonymous === undefined &&
        !(message?.replyTo?.content || "").trim();

      const shouldRenderAnonymous =
        Boolean(message?.isAnonymous) || hasLegacyAnonymousShape;

      if (shouldRenderAnonymous) {
        const senderId = String(message?.sender?._id || "");
        const isCurrentUserMessage = senderId === String(req.userId);
        message.isAnonymous = true;
        message.canAddFriend = Boolean(senderId) && !isCurrentUserMessage;
        message.sender = {
          name: "Anonymous",
        };
      } else {
        message.isAnonymous = false;
        message.canAddFriend = false;
      }
    });
  }

  const totalPages = Math.ceil(totalMessagesCount / limit) || 1;

  return res.status(200).json({
    success: true,
    message: "Messages fetched successfully",
    messages: messages.reverse(),
    totalPages,
  });
});

const suggestMessages = TryCatch(async (req, res, next) => {
  const { exclude = "" } = req.body;

  const prompt = `Create a list of three open-ended and engaging questions formatted as a single string.
    Each question should be separated by '||'. The questions are for an anonymous social messaging platform,
    and should be suitable for a diverse audience. Avoid personal or sensitive topics.
    Ensure the questions are intriguing and foster curiosity.
    DO NOT INCLUDE any of the following questions: ${exclude || "None"}.
    Each question MUST be at most 100 characters long.`;

  const { textStream } = await streamText({
    model: google("gemini-1.5-flash-8b-latest"),
    prompt: prompt,
    maxRetries: 3,
  });

  if (!textStream) {
    return res.status(500).json({
      success: false,
      message: "Failed to generate questions. Please try again.",
    });
  }

  let result = "";
  for await (const delta of textStream) {
    result += delta;
  }

  return res.status(200).json({
    success: true,
    message: result,
  });
});

const normalizeQuestion = (value = "") =>
  value
    .trim()
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

const normalizeQuestionLegacy = (value = "") =>
  value
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();


const GLOBAL_SEED_QUESTIONS = [
  "What is something small that made your day better recently?",
  "If you could instantly learn one skill, what would it be and why?",
  "What kind of conversation helps you feel most understood?",
  "What is one goal you are currently working toward?",
  "What helps you recharge after a stressful day?",
  "What motivates you when you feel stuck?",
  "If you could relive one day from last year, which day would it be?",
  "What is one thing people often misunderstand about you?",
  "What is your ideal weekend like from start to finish?",
  "What is a fear you have overcome recently?",
  "If you could travel anywhere this year, where would you go first?",
  "What habit has improved your life the most?",
];

const ensureGlobalSeeds = async () => {
  const operations = GLOBAL_SEED_QUESTIONS.map((question) => {
    const normalized = normalizeQuestion(question);

    return {
      updateOne: {
        filter: { targetUsername: null, normalizedQuestion: normalized },
        update: {
          $setOnInsert: {
            targetUsername: null,
            question,
            normalizedQuestion: normalized,
            askedCount: 0,
            answer: "",
            answeredAt: null,
          },
        },
        upsert: true,
      },
    };
  });

  try {
    await suggestedQuestionModel.bulkWrite(operations, { ordered: false });
  } catch (error) {
    const hasOnlyDupErrors =
      Array.isArray(error?.writeErrors) &&
      error.writeErrors.length > 0 &&
      error.writeErrors.every((item) => item?.code === 11000);

    if (!hasOnlyDupErrors) {
      throw error;
    }
  }
};

const storeAndDeliverMessage = async ({
  req,
  username,
  content,
  sender,
  replyTo,
  forceAnonymous = false,
  host = null,
}) => {
  const user = await userModel.findOne({ username });

  if (!user) {
    throw new ErrorHandler("User not found", 404);
  }

  if (!user.isAcceptingMessage) {
    throw new ErrorHandler("User is not accepting messages", 400);
  }

  let chatId = null;
  let targetMembers = [];
  let isAnonymousForMessage = true;

  if (sender?._id && !forceAnonymous) {
    const existingChat = await chatModel.findOne({
      groupChat: false,
      members: { $all: [sender._id, user._id] },
    });

    if (existingChat) {
      chatId = existingChat._id;
      targetMembers = existingChat.members;
      isAnonymousForMessage = false;
    } else {
      const newChat = await chatModel.create({
        name: `${user.name}`,
        groupChat: false,
        members: [sender._id, user._id],
      });
      chatId = newChat._id;
      targetMembers = newChat.members;
      isAnonymousForMessage = false;
    }
  } else {
    if (sender?._id) {
      // Create a new anonymous chat
      const newChat = await chatModel.create({
        name: "Anonymous",
        groupChat: false,
        members: [sender._id],  // Only add sender initially
        isAnonymous: true,     // Mark as anonymous chat
      });
      chatId = newChat._id;
      targetMembers = [sender._id];
    } else {
      // Keep board messages in owner's anonymous inbox chat
      let userChat = await chatModel.findById(user._id);

      if (!userChat) {
        userChat = await chatModel.findOne({
          groupChat: false,
          members: [user._id],
          name: `${user.username} - Messages`,
        });
      }

      if (!userChat) {
        userChat = await chatModel.create({
          _id: user._id,
          name: `${user.username} - Messages`,
          groupChat: false,
          members: [user._id],
        });
      }

      chatId = userChat._id;
      targetMembers = [user._id];
    }
    isAnonymousForMessage = true;
  }

  const senderIdForMessage = sender ? sender._id : user._id;

  const messageForDB = {
    chat: chatId,
    content,
    sender: senderIdForMessage,
    isAnonymous: isAnonymousForMessage,
    attachments: [],
    ...(host ? { host } : {}),
    replyTo: replyTo
      ? {
          senderName: replyTo.senderName || "",
          content: replyTo.content || "",
        }
      : undefined,
  };

  const message = await messageModel.create(messageForDB);

  // If this reply answers a board question, drop it from the priority queue.
  if ((replyTo?.content || "").trim() && (content || "").trim()) {
    markBoardQuestionAnswered({
      chatId,
      replyContent: replyTo.content,
      answerContent: content,
    }).catch(() => {});
  }

  const messageForRealTime = {
    ...messageForDB,
    sender: {
      name: isAnonymousForMessage ? "Anonymous" : sender?.name || user.name,
    },
    canAddFriend: isAnonymousForMessage && Boolean(sender?._id),
    _id: message._id,
    createdAt: message.createdAt,
  };

  const receiverSocketId = getSockets([user._id])[0];
  const receiverIsActive = Boolean(receiverSocketId);

  if (receiverIsActive) {
    emitEvent(req, NEW_MESSAGE, targetMembers, {
      message: messageForRealTime,
      chatId: messageForDB.chat,
    });

    emitEvent(req, NEW_MESSAGE_ALERT, targetMembers, {
      chatId: messageForDB.chat,
    });
  }

  return {
    message,
    realtimeDelivered: receiverIsActive,
  };
};

const sendAnonymousFriendRequest = TryCatch(async (req, res, next) => {
  const { messageId } = req.body;

  if (!messageId) {
    return next(new ErrorHandler("Message ID is required", 400));
  }

  const message = await messageModel.findById(messageId).lean();

  if (!message) {
    return next(new ErrorHandler("Message not found", 404));
  }

  if (!message.isAnonymous) {
    return next(new ErrorHandler("Message is not anonymous", 400));
  }

  if (String(message.chat) !== String(req.userId)) {
    return next(new ErrorHandler("Unauthorized anonymous message access", 403));
  }

  const targetUserId = String(message.sender || "");

  if (!targetUserId || targetUserId === String(req.userId)) {
    return next(new ErrorHandler("Invalid anonymous sender", 400));
  }

  const [requestSent, requestReceived, existingPrivateChat] = await Promise.all([
    requestModel.findOne({ sender: req.userId, receiver: targetUserId }),
    requestModel.findOne({ sender: targetUserId, receiver: req.userId }),
    chatModel.findOne({
      groupChat: false,
      members: { $all: [req.userId, targetUserId] },
    }),
  ]);

  if (existingPrivateChat) {
    return res.status(200).json({
      success: true,
      message: "You are already connected in private chat",
    });
  }

  if (requestSent || requestReceived) {
    return res.status(200).json({
      success: true,
      message: "Friend request already exists",
    });
  }

  // Add chatId to the request
  await requestModel.create({
    sender: req.userId,
    receiver: targetUserId,
    chatId: message.chat, // Store chat ID in request
  });

  emitEvent(req, NEW_REQUEST, [targetUserId], "New friend request received");

  return res.status(200).json({
    success: true,
    message: "Friend request sent successfully",
  });
});

// Accept friend request and add user to chat
const acceptFriendRequest = TryCatch(async (req, res, next) => {
  const { requestId } = req.body;

  if (!requestId) {
    return next(new ErrorHandler("Request ID is required", 400));
  }

  const request = await requestModel.findById(requestId);

  if (!request) {
    return next(new ErrorHandler("Request not found", 404));
  }

  if (request.receiver.toString() !== req.userId.toString()) {
    return next(new ErrorHandler("Unauthorized to accept this request", 403));
  }

  const [chat, sender] = await Promise.all([
    chatModel.findById(request.chatId),
    userModel.findById(request.sender),
  ]);

  if (!chat) {
    return next(new ErrorHandler("Chat not found", 404));
  }

  // Add receiver to chat members
  if (!chat.members.includes(req.userId)) {
    chat.members.push(req.userId);
    
    // Update chat name if it's anonymous
    if (chat.isAnonymous && sender) {
      chat.name = `${sender.name}`;
      chat.isAnonymous = false; // Convert to normal chat
    }
    
    await chat.save();
  }

  // Delete the request
  await requestModel.findByIdAndDelete(requestId);

  // Notify both users about the new chat
  emitEvent(req, REFETCH_CHATS, chat.members);

  return res.status(200).json({
    success: true,
    message: "Friend request accepted",
    chatId: chat._id,
  });
});

const askAndRecord = TryCatch(async (req, res, next) => {
  const { username, question, content, replyTo } = req.body;

  const normalizedUsername = (username || "").trim().toLowerCase();
  const trimmedQuestion = (question || "").trim();
  const trimmedContent = (content || "").trim();

  if (!normalizedUsername || !trimmedQuestion || !trimmedContent) {
    return next(
      new ErrorHandler("username, question, and content are required", 400)
    );
  }

  await ensureGlobalSeeds();

  const normalizedQuestion = normalizeQuestion(trimmedQuestion);
  const legacyNormalizedQuestion = normalizeQuestionLegacy(trimmedQuestion);
  const normalizedQuestionCandidates = [
    normalizedQuestion,
    legacyNormalizedQuestion,
  ].filter((value, index, arr) => Boolean(value) && arr.indexOf(value) === index);

  const askHost = resolveAskHost({
    host: req.body?.host,
    origin: req.headers?.origin,
    referer: req.headers?.referer,
  });

  let existing = await suggestedQuestionModel.findOne({
    targetUsername: normalizedUsername,
    normalizedQuestion: { $in: normalizedQuestionCandidates },
  });

  if (existing?.answer?.trim()) {
    existing = await suggestedQuestionModel.findOneAndUpdate(
      { _id: existing._id },
      { $inc: { askedCount: 1 }, $addToSet: { hosts: askHost } },
      { new: true }
    );

    // Emit real-time update to board owner
    const boardOwner = await userModel.findOne({
      username: normalizedUsername,
    }).lean();

    if (boardOwner) {
      emitEvent(req, QUESTION_ASKED, [boardOwner._id], {
        questionId: existing._id,
        question: existing.question,
        askedCount: existing.askedCount || 1,
        normalizedQuestion: existing.normalizedQuestion,
      });
    }

    return res.status(200).json({
      success: true,
      alreadyAsked: true,
      alreadyAnswered: true,
      answeredQuestion: existing.question,
      answeredAnswer: existing.answer,
      messageSent: false,
      realtimeDelivered: false,
    });
  }

  if (existing && (existing.askedCount || 0) > 0) {
    existing = await suggestedQuestionModel.findOneAndUpdate(
      { _id: existing._id },
      { $inc: { askedCount: 1 }, $addToSet: { hosts: askHost } },
      { new: true }
    );

    // Emit real-time update to board owner
    const boardOwner = await userModel.findOne({
      username: normalizedUsername,
    }).lean();

    if (boardOwner) {
      emitEvent(req, QUESTION_ASKED, [boardOwner._id], {
        questionId: existing._id,
        question: existing.question,
        askedCount: existing.askedCount || 1,
        normalizedQuestion: existing.normalizedQuestion,
      });
    }

    return res.status(200).json({
      success: true,
      alreadyAsked: true,
      alreadyAnswered: false,
      answeredQuestion: null,
      answeredAnswer: null,
      messageSent: false,
      realtimeDelivered: false,
    });
  }

  if (existing) {
    existing = await suggestedQuestionModel.findOneAndUpdate(
      { _id: existing._id },
      {
        $set: {
          question: trimmedQuestion,
          normalizedQuestion,
        },
        $inc: { askedCount: 1 }, $addToSet: { hosts: askHost },
      },
      { new: true }
    );
  } else {
    try {
      existing = await suggestedQuestionModel.findOneAndUpdate(
        { targetUsername: normalizedUsername, normalizedQuestion },
        {
          $setOnInsert: {
            targetUsername: normalizedUsername,
            question: trimmedQuestion,
            normalizedQuestion,
            answer: "",
            answeredAt: null,
          },
          $inc: { askedCount: 1 }, $addToSet: { hosts: askHost },
        },
        { upsert: true, new: true }
      );
    } catch (error) {
      const duplicateError = error?.code === 11000;
      if (!duplicateError) {
        throw error;
      }

      existing = await suggestedQuestionModel.findOne({
        targetUsername: normalizedUsername,
        normalizedQuestion: { $in: normalizedQuestionCandidates },
      });

      if (existing && (existing.askedCount || 0) > 0) {
        existing = await suggestedQuestionModel.findOneAndUpdate(
          { _id: existing._id },
          { $inc: { askedCount: 1 }, $addToSet: { hosts: askHost } },
          { new: true }
        );

        // Emit real-time update to board owner
        const boardOwner = await userModel.findOne({
          username: normalizedUsername,
        }).lean();

        if (boardOwner) {
          emitEvent(req, QUESTION_ASKED, [boardOwner._id], {
            questionId: existing._id,
            question: existing.question,
            askedCount: existing.askedCount || 1,
            normalizedQuestion: existing.normalizedQuestion,
          });
        }

        return res.status(200).json({
          success: true,
          alreadyAsked: true,
          alreadyAnswered: Boolean(existing.answer?.trim()),
          answeredQuestion: existing.answer?.trim() ? existing.question : null,
          answeredAnswer: existing.answer?.trim() ? existing.answer : null,
          messageSent: false,
          realtimeDelivered: false,
        });
      }

      if (existing) {
        existing = await suggestedQuestionModel.findOneAndUpdate(
          { _id: existing._id },
          {
            $set: {
              question: trimmedQuestion,
              normalizedQuestion,
            },
            $inc: { askedCount: 1 }, $addToSet: { hosts: askHost },
          },
          { new: true }
        );
      }
    }
  }

  const alreadyAnswered = Boolean(existing?.answer?.trim());
  const answeredQuestion = alreadyAnswered ? existing.question : null;
  const answeredAnswer = alreadyAnswered ? existing.answer : null;

  let messageSent = false;
  let realtimeDelivered = false;

  if (!alreadyAnswered) {
    const senderFromCookie = await resolveSenderFromCookie(req);

    const deliveryResult = await storeAndDeliverMessage({
      req,
      username: normalizedUsername,
      content: trimmedContent,
      sender: senderFromCookie,
      replyTo,
      forceAnonymous: true,
      host: askHost,
    });

    messageSent = Boolean(deliveryResult?.message?._id);
    realtimeDelivered = Boolean(deliveryResult?.realtimeDelivered);
  }
  
    // Emit real-time update to board owner about ask count
    const boardOwner = await userModel.findOne({
      username: normalizedUsername,
    }).lean();
  
    if (boardOwner && existing) {
      emitEvent(req, QUESTION_ASKED, [boardOwner._id], {
        questionId: existing._id,
        question: existing.question,
        askedCount: existing.askedCount || 1,
        normalizedQuestion: existing.normalizedQuestion,
      });
    }
  
    return res.status(200).json({
      success: true,
      alreadyAsked: false,
      alreadyAnswered,
      answeredQuestion,
      answeredAnswer,
      messageSent,
      realtimeDelivered,
    });
  });

const sendMessage = TryCatch(async (req, res, next) => {
  const { username, content, replyTo } = req.body;

  if (!username) {
    return next(new ErrorHandler("Username is required", 400));
  }

  if (!content) {
    return next(new ErrorHandler("Message content is required", 400));
  }

  const senderFromCookie = await resolveSenderFromCookie(req);

  const deliveryResult = await storeAndDeliverMessage({
    req,
    username: (username || "").trim().toLowerCase(),
    content,
    sender: senderFromCookie,
    replyTo,
    host: resolveAskHost({
      host: req.body?.host,
      origin: req.headers?.origin,
      referer: req.headers?.referer,
    }),
  });

  return res.status(200).json({
    success: true,
    message: "Message sent successfully",
    messageStored: Boolean(deliveryResult?.message?._id),
    realtimeDelivered: Boolean(deliveryResult?.realtimeDelivered),
  });
});

const AI_USERNAME = "ai_assistant";

const getAiUser = async () => {
  const existing = await userModel.findOne({ username: AI_USERNAME }).lean();
  if (existing) return existing;

  try {
    const created = await userModel.create({
      name: "AI Assistant",
      email: "ai.assistant@stealthynote.local",
      username: AI_USERNAME,
      password: `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      avatar: {
        public_id: "ai_assistant",
        url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E🤖%3C/text%3E%3C/svg%3E",
      },
    });
    return created.toObject();
  } catch {
    return userModel.findOne({ username: AI_USERNAME }).lean();
  }
};

/**
 * Ask-AI with chat context. mode "shared" saves + broadcasts the reply to
 * everyone; anything else saves it privately (visible only to the asker,
 * surviving reloads) and emits it to the asker alone.
 */
const askAi = TryCatch(async (req, res, next) => {
  const { chatId, question, mode = "private" } = req.body;
  const trimmedQuestion = (question || "").trim();

  if (!chatId) return next(new ErrorHandler("Chat ID is required", 400));
  if (!trimmedQuestion) return next(new ErrorHandler("Question is required", 400));

  const chat = await chatModel.findById(chatId);

  if (!chat) return next(new ErrorHandler("Chat not found", 404));

  if (!chat.members.some((member) => String(member) === String(req.userId))) {
    return next(new ErrorHandler("You are not a member of this chat", 403));
  }

  if (chat.aiEnabled === false) {
    return next(new ErrorHandler("AI mode is turned off for this chat", 403));
  }

  const recentMessages = await messageModel
    .find({ chat: chatId })
    .populate("sender", "name")
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  const history = recentMessages.reverse().map((msg) => ({
    senderName: msg?.sender?.name || "Someone",
    content: msg?.content || "",
  }));

  const answer = await askNvidiaWithContext({ history, question: trimmedQuestion });

  if (!answer) {
    return next(new ErrorHandler("AI could not answer right now. Try again.", 502));
  }

  const aiUser = await getAiUser();

  if (!aiUser) {
    return next(new ErrorHandler("AI could not answer right now. Try again.", 500));
  }

  const isPrivate = mode !== "shared";

  const message = await messageModel.create({
    chat: chatId,
    content: answer,
    sender: aiUser._id,
    ...(isPrivate ? { privateTo: req.userId } : {}),
  });

  publishAiMessage(
    req,
    { chat, answer, message },
    isPrivate ? [req.userId] : chat.members
  );

  const notifiedSockets = getSockets(
    (isPrivate ? [req.userId] : chat.members).map((member) => member.toString())
  );

  return res.status(200).json({
    success: true,
    answer,
    messageId: message._id,
    private: isPrivate,
    realtimeDelivered: notifiedSockets.length > 0,
  });
});

/**
 * Shares a private AI answer with the whole chat: clears its exclusive
 * visibility and broadcasts it. Accepts either the private message's id
 * (published as-is) or raw answer text (saved + shared, legacy path).
 */
const shareAi = TryCatch(async (req, res, next) => {
  const { chatId, messageId, answer } = req.body;

  if (!chatId) return next(new ErrorHandler("Chat ID is required", 400));

  const chat = await chatModel.findById(chatId);

  if (!chat) return next(new ErrorHandler("Chat not found", 404));

  if (!chat.members.some((member) => String(member) === String(req.userId))) {
    return next(new ErrorHandler("You are not a member of this chat", 403));
  }

  if (chat.aiEnabled === false) {
    return next(new ErrorHandler("AI mode is turned off for this chat", 403));
  }

  let message;

  if (messageId) {
    message = await messageModel.findOne({ _id: messageId, chat: chatId });

    if (!message) return next(new ErrorHandler("Message not found", 404));

    if (String(message.privateTo || "") !== String(req.userId)) {
      return next(new ErrorHandler("Only your own private AI answer can be shared", 403));
    }

    message.privateTo = null;
    await message.save();
  } else {
    const trimmedAnswer = (answer || "").trim().slice(0, 1200);

    if (!trimmedAnswer) {
      return next(new ErrorHandler("Message id or answer text is required", 400));
    }

    const aiUser = await getAiUser();

    if (!aiUser) {
      return next(new ErrorHandler("AI is unavailable right now. Try again.", 500));
    }

    message = await messageModel.create({
      chat: chatId,
      content: trimmedAnswer,
      sender: aiUser._id,
    });
  }

  publishAiMessage(req, { chat, answer: message.content, message });

  return res.status(200).json({
    success: true,
    messageId: message._id,
    realtimeDelivered: getSockets(chat.members.map((member) => member.toString())).length > 0,
  });
});

/** Deletes your own private AI answer (persisted preview cleanup). */
const deleteAiMessage = TryCatch(async (req, res, next) => {
  const { messageId } = req.params;

  if (!messageId) return next(new ErrorHandler("Message ID is required", 400));

  const message = await messageModel.findById(messageId);

  if (!message) return next(new ErrorHandler("Message not found", 404));

  if (String(message.privateTo || "") !== String(req.userId)) {
    return next(new ErrorHandler("Only your own private AI answer can be deleted", 403));
  }

  await message.deleteOne();

  return res.status(200).json({ success: true });
});

/** Broadcasts an AI message to the given members. */
const publishAiMessage = (req, { chat, answer, message }, members) => {
  const targets = members || chat.members;
  const messageForRealTime = {
    _id: message._id,
    attachments: [],
    content: answer,
    sender: { _id: message.sender, name: "AI Assistant" },
    chat: message.chat,
    createdAt: message.createdAt,
    ...(message.privateTo ? { privateTo: message.privateTo } : {}),
  };

  emitEvent(req, NEW_MESSAGE, targets, {
    chatId: String(message.chat),
    message: messageForRealTime,
  });
  emitEvent(req, NEW_MESSAGE_ALERT, targets, { chatId: String(message.chat) });
};

export {
  addGroupMembers,
  deleteChat,
  getChatDetails,
  getMessages,
  getMyChats,
  getMyGroups,
  leaveGroup,
  newGroupChat,
  askAndRecord,
  removeMember,
  renameGroup,
  sendAnonymousFriendRequest,
  acceptFriendRequest,
  sendAttachments,
  sendMessage,
  suggestMessages,
  askAi,
  shareAi,
  deleteAiMessage,
};
