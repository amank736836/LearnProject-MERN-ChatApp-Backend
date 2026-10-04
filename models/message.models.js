import mongoose, { model, Schema, Types } from "mongoose";

const messageSchema = new Schema(
  {
    sender: {
      type: Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Website the ask came from (Origin header), for per-site filtering.
    host: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
      index: true,
    },
    // Set only for private AI answers: visible solely to this user.
    privateTo: {
      type: Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    chat: {
      type: Types.ObjectId,
      ref: "Chat",
      required: true,
    },
    content: {
      type: String,
    },
    replyTo: {
      senderName: {
        type: String,
        trim: true,
        default: "",
      },
      content: {
        type: String,
        trim: true,
        default: "",
      },
    },
    isAnonymous: {
      type: Boolean,
      default: false,
      index: true,
    },
    hiddenFromShowcase: {
      type: Boolean,
      default: false,
      index: true,
    },
    attachments: [
      {
        public_id: {
          type: String,
          required: true,
        },
        url: {
          type: String,
          required: true,
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

const messageModel =
  mongoose.models.Message || model("Message", messageSchema, "messages");

export default messageModel;
