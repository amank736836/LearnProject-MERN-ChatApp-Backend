import mongoose, { model, Schema, Types } from "mongoose";

const expiryTime = 1;

let currentDate = new Date();

currentDate.setMinutes(currentDate.getMinutes() + expiryTime);

const chatSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 100,
    },
    groupChat: {
      type: Boolean,
      default: false,
    },
    aiEnabled: {
      type: Boolean,
      default: true,
    },
    creator: {
      type: Types.ObjectId,
      ref: "User",
    },
    members: [
      {
        type: Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],
  },
  {
    timestamps: true,
  }
);

const chatModel = mongoose.models.Chat || model("Chat", chatSchema, "chats");

export default chatModel;
