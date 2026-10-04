import suggestedQuestionModel from "../models/suggestedQuestion.models.js";
import userModel from "../models/user.models.js";

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

// Trimmed variants included: stored rows historically keep a trailing space
// when the question ends in punctuation, while new quotes may not.
export const getNormalizedQuestionCandidates = (value = "") =>
  [
    normalizeQuestion(value),
    normalizeQuestionLegacy(value),
    normalizeQuestion(value).trim(),
    normalizeQuestionLegacy(value).trim(),
  ].filter((v, i, arr) => Boolean(v) && arr.indexOf(v) === i);

/**
 * When the board owner replies to a question on their board inbox,
 * mark the matching SuggestedQuestion as answered so it leaves the
 * priority queue. Board inbox chats reuse the owner's user _id as the
 * chat _id, so replies in any other chat are ignored. Never throws.
 */
export const markBoardQuestionAnswered = async ({
  chatId,
  replyContent,
  answerContent,
}) => {
  try {
    const questionText = (replyContent || "").trim();
    const answerText = (answerContent || "").trim();

    if (!questionText || !answerText) return null;

    const boardOwner = await userModel
      .findById(chatId)
      .select("_id username")
      .lean();

    if (!boardOwner?.username) return null;

    const candidates = getNormalizedQuestionCandidates(questionText);

    if (candidates.length === 0) return null;

    return await suggestedQuestionModel.findOneAndUpdate(
      {
        targetUsername: boardOwner.username.toLowerCase(),
        normalizedQuestion: { $in: candidates },
      },
      { $set: { answer: answerText, answeredAt: new Date() } },
      { new: true }
    );
  } catch {
    return null;
  }
};
