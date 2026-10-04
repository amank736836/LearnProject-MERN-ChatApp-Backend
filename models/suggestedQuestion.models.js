import mongoose, { model, Schema } from "mongoose";

const suggestedQuestionSchema = new Schema(
  {
    targetUsername: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
      index: true,
    },
    question: {
      type: String,
      required: true,
      trim: true,
    },
    normalizedQuestion: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    askedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Distinct websites this question was asked from (per-site filtering).
    hosts: {
      type: [String],
      default: [],
      index: true,
    },
    answer: {
      type: String,
      default: "",
      trim: true,
    },
    answeredAt: {
      type: Date,
      default: null,
    },
    hiddenFromShowcase: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

suggestedQuestionSchema.index(
  { targetUsername: 1, normalizedQuestion: 1 },
  { unique: true }
);

const suggestedQuestionModel =
  mongoose.models.SuggestedQuestion ||
  model("SuggestedQuestion", suggestedQuestionSchema, "suggestedquestions");

export default suggestedQuestionModel;
