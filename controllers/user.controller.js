import { compare } from "bcrypt";
import { cookieOptions, STEALTHY_NOTE_TOKEN_NAME } from "../app.js";
import { ErrorHandler, TryCatch } from "../middlewares/error.js";
import chatModel from "../models/chat.models.js";
import messageModel from "../models/message.models.js";
import requestModel from "../models/request.models.js";
import userModel from "../models/user.models.js";
import { NEW_REQUEST, REFETCH_CHATS } from "../utils/events.js";
import {
  emitEvent,
  sendForgotPasswordEmail,
  sendToken,
  sendVerificationEmail,
  uploadFilesToCloudinary,
} from "../utils/features.js";

const newUser = TryCatch(async (req, res, next) => {
  const { name, email, password, username } = req.body;

  if (!name) {
    return next(new ErrorHandler("Name is required", 400));
  }

  if (name.length < 3) {
    return next(new ErrorHandler("Name must be at least 3 characters", 400));
  }

  if (!email) return next(new ErrorHandler("Email is required", 400));

  if (!email.includes("@")) return next(new ErrorHandler("Invalid email", 400));

  if (!password) return next(new ErrorHandler("Password is required", 400));

  if (!username) return next(new ErrorHandler("Username is required", 400));

  if (username.length < 3) {
    return next(
      new ErrorHandler("Username must be at least 3 characters", 400)
    );
  }

  if (username.length > 30) {
    return next(
      new ErrorHandler("Username must be at most 30 characters", 400)
    );
  }

  if (password.length < 6) {
    return next(
      new ErrorHandler("Password must be at least 6 characters", 400)
    );
  }

  if (password.length > 30) {
    return next(
      new ErrorHandler("Password must be at most 30 characters", 400)
    );
  }

  const file = req.file;

  // if (!file) {
  //   return next(new ErrorHandler("Avatar is required", 400));
  // }

  let avatar = {
    public_id: "StealthyNote/c348f2a5-adba-4a0d-90b6-b93f21cacf1a",
    url: "https://res.cloudinary.com/amank736836/image/upload/v1747106860/StealthyNote/c348f2a5-adba-4a0d-90b6-b93f21cacf1a.jpg",
  };

  if (file) {
    const result = await uploadFilesToCloudinary([file]);
    avatar = {
      public_id: result[0].public_id,
      url: result[0].url,
    };
  }

  const existingUserVerifiedByUsername = await userModel.findOne({
    username,
    isVerified: true,
  });

  if (existingUserVerifiedByUsername) {
    return next(new ErrorHandler("Username already exists", 400));
  }

  const existingUserByEmail = await userModel.findOne({
    email,
  });

  const verifyCode = Math.floor(100000 + Math.random() * 900000);

  const verifyCodeExpiry = new Date();
  verifyCodeExpiry.setHours(verifyCodeExpiry.getHours() + 1);

  if (existingUserByEmail) {
    if (existingUserByEmail.isVerified) {
      return next(new ErrorHandler("Email already exists", 400));
    } else {
      existingUserByEmail.name = name;
      existingUserByEmail.avatar = avatar;
      existingUserByEmail.username = username;
      existingUserByEmail.password = password;
      existingUserByEmail.verifyCode = verifyCode;
      existingUserByEmail.verifyCodeExpiry = verifyCodeExpiry;

      await existingUserByEmail.save();
    }
  } else {
    const user = await userModel.create({
      name,
      username,
      email,
      avatar,
      password,
      verifyCode,
      verifyCodeExpiry,
    });
    const chat = await chatModel.create({
      _id: user._id,
      members: [user._id],
      groupChat: true,
      name: user.name,
      creator: user._id,
    });
  }

  const baseUrl = req.headers.origin;

  const emailResponse = await sendVerificationEmail({
    baseUrl,
    email,
    username,
    verifyCode,
  });

  if (!emailResponse.success) {
    return next(new ErrorHandler("Failed to send email", 500));
  }

  return res.status(200).json({
    success: true,
    message: "User created successfully. Please verify your email.",
  });
});

const login = TryCatch(async (req, res, next) => {
  const { identifier, password } = req.body;

  if (!identifier) return next(new ErrorHandler("Username is required", 400));

  if (!password) return next(new ErrorHandler("Password is required", 400));

  const user = await userModel
    .findOne({
      $or: [{ username: identifier }, { email: identifier }],
    })
    .select("+password");

  if (!user) return next(new ErrorHandler("User not found", 404));

  const isMatch = await compare(password, user.password);

  if (!isMatch) return next(new ErrorHandler("Invalid password", 401));

  if (!user.isVerified) {
    if (user.verifyCodeExpiry < new Date()) {
      const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();

      const verifyCodeExpiry = new Date(Date.now() + 10 * 60 * 1000);

      user.verifyCode = verifyCode;
      user.verifyCodeExpiry = verifyCodeExpiry;

      const res = await user.save();

      const baseUrl = req.headers.origin;
      const emailResponse = await sendVerificationEmail({
        baseUrl,
        email: user.email,
        username: user.username,
        verifyCode,
      });

      if (!emailResponse.success) {
        return next(new ErrorHandler("Failed to send verification email", 500));
      }

      return next(
        new ErrorHandler(
          "Please verify your account. A new verification code has been sent to your email.",
          400
        )
      );
    } else {
      return next(
        new ErrorHandler(
          "Please verify your account. A verification code has been sent to your email.",
          400
        )
      );
    }
  }

  sendToken(res, user, 200, "Welcome Back!");
});

const forgotPassword = TryCatch(async (req, res, next) => {
  const { identifier } = req.body;

  if (!identifier) {
    return next(new ErrorHandler("Identifier is required", 400));
  }

  const user = await userModel.findOne({
    $or: [{ email: identifier }, { username: identifier }],
  });

  if (!user) {
    return next(new ErrorHandler("User not found", 404));
  }

  const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();

  const verifyCodeExpiry = new Date(Date.now() + 10 * 60 * 1000);

  user.verifyCode = verifyCode;
  user.verifyCodeExpiry = verifyCodeExpiry;
  await user.save();

  const baseUrl = req.headers.origin;

  const emailResponse = await sendForgotPasswordEmail({
    baseUrl,
    username: user.username,
    email: user.email,
    verifyCode,
  });

  if (!emailResponse.success) {
    return next(new ErrorHandler("Failed to send email", 500));
  }

  return res.status(200).json({
    success: true,
    message: "Forgot password code sent successfully. Please check your email.",
  });
});

const updatePassword = TryCatch(async (req, res, next) => {
  const { identifier, verifyCode, password } = req.body;

  if (!identifier) {
    return next(new ErrorHandler("Identifier is required", 400));
  }

  if (!verifyCode) {
    return next(new ErrorHandler("Verify code is required", 400));
  }

  if (!password) {
    return next(new ErrorHandler("Password is required", 400));
  }

  const user = await userModel.findOne({
    $or: [{ email: identifier }, { username: identifier }],
  });

  if (!user) {
    return next(new ErrorHandler("User not found", 404));
  }

  if (user.verifyCode !== verifyCode) {
    return next(new ErrorHandler("Invalid verify code", 400));
  }

  if (user.verifyCodeExpiry < Date.now()) {
    return next(new ErrorHandler("Verify code expired", 400));
  }

  user.password = password;
  user.verifyCode = null;
  user.verifyCodeExpiry = null;

  await user.save();

  sendToken(res, user, 200, "Password updated successfully");

  return res.status(200).json({
    success: true,
    message: "Password updated successfully",
  });
});

const verifyUser = TryCatch(async (req, res, next) => {
  const { identifier, verifyCode } = req.body;

  if (!identifier) {
    return next(new ErrorHandler("Identifier is required", 400));
  }

  if (!verifyCode) {
    return next(new ErrorHandler("Verify code is required", 400));
  }

  const user = await userModel.findOne({
    $or: [{ email: identifier }, { username: identifier }],
  });

  if (!user) {
    return next(new ErrorHandler("User not found", 404));
  }

  if (user.verifyCode !== verifyCode) {
    return next(new ErrorHandler("Invalid verify code", 400));
  }

  if (user.verifyCodeExpiry < Date.now()) {
    const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();

    const verifyCodeExpiry = new Date(Date.now() + 10 * 60 * 1000);

    user.verifyCode = verifyCode;
    user.verifyCodeExpiry = verifyCodeExpiry;

    await user.save();

    const baseUrl = req.headers.origin;
    const emailResponse = await sendVerificationEmail({
      baseUrl,
      email: user.email,
      username: user.username,
      verifyCode,
    });

    if (!emailResponse.success) {
      return next(new ErrorHandler("Failed to send verification email", 500));
    }

    return next(new ErrorHandler("Verify code expired", 400));
  }

  user.verifyCode = null;
  user.verifyCodeExpiry = null;
  user.isVerified = true;

  await user.save();

  sendToken(res, user, 200, "User verified successfully");
});

const getMyProfile = TryCatch(async (req, res, next) => {
  if (!req.userId)
    return next(new ErrorHandler("Login to access this resource", 401));

  const [user, notificationCount] = await Promise.all([
    userModel.findById(req.userId),
    requestModel.countDocuments({
      receiver: req.userId,
      status: "pending",
    }),
  ]);

  if (!user) return next(new ErrorHandler("User not found", 404));

  res.status(200).json({
    success: true,
    user,
    notificationCount,
  });
});

const logout = TryCatch(async (req, res, next) => {
  res.cookie(STEALTHY_NOTE_TOKEN_NAME, null, {
    ...cookieOptions,
    maxAge: 0,
  });

  res.status(200).json({
    success: true,
    message: "Logged out successfully",
  });
});

const searchUser = TryCatch(async (req, res, next) => {
  const { name = "" } = req.query;

  const myChats = await chatModel.find({
    groupChat: false,
    members: req.userId,
  });

  const allUsersFromMyChats = myChats.flatMap((chat) => chat.members);

  allUsersFromMyChats.push(req.userId);

  const allUsersExceptMeAndFriends = await userModel.find({
    _id: { $nin: allUsersFromMyChats },
    name: { $regex: name, $options: "i" },
  });

  const allUsersRequest = await requestModel.find({
    $or: [{ sender: req.userId }, { receiver: req.userId }],
  });

  const allUsersExceptMeAndFriendsWithoutRequest =
    allUsersExceptMeAndFriends.filter(
      (user) =>
        !allUsersRequest.some(
          (request) =>
            (request.sender.toString() === user._id.toString() &&
              request.receiver.toString() === req.userId) ||
            (request.receiver.toString() === user._id.toString() &&
              request.sender.toString() === req.userId)
        )
    );

  const users = allUsersExceptMeAndFriendsWithoutRequest.map(
    ({ _id, name, avatar }) => ({
      id: _id,
      name,
      avatar: avatar.url,
    })
  );

  res.status(200).json({
    success: true,
    message: `Search for ${name}`,
    users,
  });
});

const sendFriendRequest = TryCatch(async (req, res, next) => {
  const { userId } = req.body;

  if (!userId) return next(new ErrorHandler("User ID is required", 400));

  if (userId === req.userId) {
    return next(new ErrorHandler("You cannot send a request to yourself", 400));
  }

  const [requestSent, requestReceived] = await Promise.all([
    requestModel.findOne({
      sender: req.userId,
      receiver: userId,
    }),
    requestModel.findOne({
      sender: userId,
      receiver: req.userId,
    }),
  ]);

  if (requestSent) {
    return res.status(200).json({
      success: true,
      message: "Friend request sent successfully",
    });
  }

  if (requestReceived) {
    return next(new ErrorHandler("Request already received", 400));
  }

  await requestModel.create({
    sender: req.userId,
    receiver: userId,
  });

  emitEvent(req, NEW_REQUEST, [userId], "New friend request received");

  res.status(200).json({
    success: true,
    message: "Friend request sent successfully",
  });
});

const acceptFriendRequest = TryCatch(async (req, res, next) => {
  const { requestId, accept } = req.body;

  if (!requestId) return next(new ErrorHandler("Request ID is required", 400));

  if (accept === undefined) {
    return next(new ErrorHandler("Accept or reject is required", 400));
  }

  if (accept !== true && accept !== false) {
    return next(new ErrorHandler("Accept or reject must be a boolean", 400));
  }

  const request = await requestModel
    .findById(requestId)
    .populate("sender", "name")
    .populate("receiver", "name");

  if (!request) return next(new ErrorHandler("Request not found", 404));

  if (request.receiver._id.toString() !== req.userId) {
    return next(
      new ErrorHandler(
        `You are not authorized to accept this request ${request}`,
        403
      )
    );
  }

  if (!accept) {
    await request.deleteOne();
    return res.status(200).json({
      success: true,
      message: "Friend request rejected successfully",
    });
  }

  const members = [request.sender._id, request.receiver._id];

  const chat = await chatModel.create({
    members,
    name: `${request.sender.name} - ${request.receiver.name}`,
    groupChat: false,
    creator: req.userId,
  });

  await messageModel.updateMany(
    {
      $or: [
        { sender: request.sender._id, chat: request.receiver._id },
        { sender: req.userId, chat: request.sender._id },
      ],
    },
    {
      chat: chat._id,
      isAnonymous: false,
    }
  );

  await request.deleteOne();

  emitEvent(
    req,
    REFETCH_CHATS,
    [request.sender._id, request.receiver._id],
    "Friend request accepted"
  );

  return res.status(200).json({
    success: true,
    message: "Friend request accepted successfully",
    senderId: request.sender._id,
  });
});

const getMyNotifications = TryCatch(async (req, res, next) => {
  const requests = await requestModel
    .find({
      receiver: req.userId,
      status: "pending",
    })
    .populate("sender", "name avatar");

  const allRequests = requests.map(({ _id, sender }) => ({
    _id,
    sender: {
      id: sender._id,
      name: sender.name,
      avatar: sender.avatar.url,
    },
  }));

  res.status(200).json({
    success: true,
    message: "All notifications",
    allRequests,
  });
});

const getMyFriends = TryCatch(async (req, res, next) => {
  const { chatId } = req.query;

  const chats = await chatModel
    .find({
      members: req.userId,
      groupChat: false,
    })
    .populate("members", "name avatar");

  const friendsExceptMe = chats.map(({ _id, members }) => {
    let otherMember = null;
    if (_id.toString() !== req.userId) {
      otherMember = members.find(
        (member) => member._id.toString() !== req.userId
      );
    } else {
      otherMember = members[0];
    }
    return {
      _id: otherMember._id,
      name: otherMember.name,
      avatar: otherMember.avatar.url,
    };
  });

  const uniqueFriends = friendsExceptMe
    .filter(
      (friend, index, self) =>
        index ===
        self.findIndex((f) => f._id.toString() === friend._id.toString())
    )
    .filter((user) => user._id.toString() !== req.userId.toString());

  if (chatId) {
    const chat = await chatModel.findById(chatId);

    if (!chat) return next(new ErrorHandler("Chat not found", 404));

    const availableFriends = uniqueFriends.filter(
      (friend) => !chat.members.includes(friend._id)
    );

    return res.status(200).json({
      success: true,
      message: "All friends",
      friends: availableFriends,
    });
  } else {
    return res.status(200).json({
      success: true,
      message: "All friends",
      friends: uniqueFriends,
    });
  }
});

const acceptMessages = TryCatch(async (req, res, next) => {
  const { isAcceptingMessage } = req.body;

  if (isAcceptingMessage === undefined) {
    return next(new ErrorHandler("isAcceptingMessage is required", 400));
  }

  const user = await userModel.findByIdAndUpdate(
    req.userId,
    { isAcceptingMessage: isAcceptingMessage },
    { new: true, runValidators: true }
  );

  if (!user) return next(new ErrorHandler("User not found", 404));

  res.status(200).json({
    success: true,
    message: `You are now ${
      isAcceptingMessage ? "accepting" : "not accepting"
    } messages`,
  });
});

export {
  acceptFriendRequest,
  acceptMessages,
  forgotPassword,
  getMyFriends,
  getMyNotifications,
  getMyProfile,
  login,
  logout,
  newUser,
  searchUser,
  sendFriendRequest,
  updatePassword,
  verifyUser,
};
