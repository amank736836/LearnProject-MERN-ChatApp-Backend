const NVIDIA_API_BASE = "https://integrate.api.nvidia.com/v1";
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || "nvidia/nemotron-3.5-lightning-30b-a3b";
const AI_HISTORY_LIMIT = 20;
const AI_MAX_ANSWER_CHARS = 1200;

/** "Name: message" transcript lines, oldest first, capped. Pure. */
export const buildAiTranscript = (messages = [], limit = AI_HISTORY_LIMIT) =>
  (Array.isArray(messages) ? messages : [])
    .slice(-limit)
    .map((msg) => {
      const name = msg?.senderName || msg?.sender?.name || "Someone";
      const content = String(msg?.content || "").replace(/\s+/g, " ").trim();
      return content ? `${name}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n");

/** Asks NVIDIA with conversation context. Returns answer string or null. Never throws. */
export const askNvidiaWithContext = async ({ history = [], question = "" } = {}) => {
  const apiKey = process.env.NVIDIA_API_KEY;
  const trimmedQuestion = String(question || "").trim();

  if (!apiKey || !trimmedQuestion) return null;

  const transcript = buildAiTranscript(history);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    const response = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a helpful friend in a group chat. Answer directly and concisely. No thinking process, no markdown headers.",
          },
          {
            role: "user",
            content:
              "Answer only the person who asked, using the conversation for context. " +
              "Be concise, warm, and practical.\n" +
              (transcript ? `Conversation so far:\n${transcript}\n` : "") +
              `Question: ${trimmedQuestion}`,
          },
        ],
        max_tokens: 2500,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const payload = await response.json();
    const answer = String(payload?.choices?.[0]?.message?.content || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, AI_MAX_ANSWER_CHARS);

    return answer || null;
  } catch {
    return null;
  }
};
