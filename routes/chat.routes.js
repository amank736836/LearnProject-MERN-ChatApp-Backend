import { Router } from "express";
import {
  addGroupMembers,
  askAndRecord,
  deleteChat,
  getChatDetails,
  getMessages,
  getMyChats,
  getMyGroups,
  leaveGroup,
  newGroupChat,
  removeMember,
  renameGroup,
  sendAnonymousFriendRequest,
  acceptFriendRequest,
  sendAttachments,
  sendMessage,
  suggestMessages,
} from "../controllers/chat.controller.js";
import { isAuthenticated } from "../middlewares/auth.js";
import { attachmentsMulter } from "../middlewares/multer.js";
import {
  addMembersValidator,
  idValidator,
  leaveGroupValidator,
  newGroupChatValidator,
  removeMembersValidator,
  renameGroupValidator,
  sendAttachmentsValidator,
  validateHandler,
} from "../utils/validators.js";
const chatRouter = Router();

chatRouter.post("/suggestMessages", suggestMessages);

chatRouter.post("/ask-and-record", askAndRecord);

chatRouter.post("/sendMessage", sendMessage);

chatRouter.use(isAuthenticated);

chatRouter.put("/anonymous-request", sendAnonymousFriendRequest);
chatRouter.put("/accept-friend-request", acceptFriendRequest);

chatRouter.get("/", getMyChats);

chatRouter
  .route("/group")
  .get(getMyGroups)
  .post(newGroupChatValidator(), validateHandler, newGroupChat)
  .put(addMembersValidator(), validateHandler, addGroupMembers)
  .delete(leaveGroupValidator(), validateHandler, leaveGroup);

chatRouter.put(
  "/removeMember",
  removeMembersValidator(),
  validateHandler,
  removeMember
);

chatRouter.post(
  "/message",
  attachmentsMulter,
  sendAttachmentsValidator(),
  validateHandler,
  sendAttachments
);

chatRouter.get("/message/:chatId", idValidator(), validateHandler, getMessages);

chatRouter
  .route("/:chatId")
  .get(idValidator(), validateHandler, getChatDetails)
  .put(renameGroupValidator(), validateHandler, renameGroup)
  .delete(idValidator(), validateHandler, deleteChat);

export default chatRouter;
