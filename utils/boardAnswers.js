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
 * Normalizes a website host for attribution ("https://Example.com:3000/x"
 * -> "example.com"). Unparseable values become "direct".
 */
export const sanitizeHost = (value = "") => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "direct";

  let host = raw;
  const originMatch = raw.match(/^https?:\/\/([^/:?#]+)/);
  if (originMatch) {
    host = originMatch[1];
  } else {
    host = raw.split(/[/:?#]/)[0];
  }

  host = host.replace(/\.+$/, "").trim();

  if (!host || host.length > 100 || !/^[a-z0-9.-]+$/.test(host)) return "direct";
  if (!host.includes(".") && host !== "localhost") return "direct";
  return host;
};

/** Picks the ask origin: explicit body.host wins, else Origin/Referer headers. */
export const resolveAskHost = ({ host, origin, referer } = {}) => {
  const explicit = sanitizeHost(host);
  if (explicit !== "direct") return explicit;
  const fromOrigin = sanitizeHost(origin);
  if (fromOrigin !== "direct") return fromOrigin;
  return sanitizeHost(referer);
};
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
