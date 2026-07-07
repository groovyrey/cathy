import { requireEnv } from "./env";
import { db } from "./db";

export async function chatWithGemma(message: string, userId: string): Promise<string> {
  const apiKey = requireEnv("GEMINI_API_KEY");
  const model = "gemma-4-31b-it";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // 1. Retrieve last 15 messages for context
  let context: any[] = [];
  try {
    const history = await db.execute({
      sql: "SELECT role, content FROM chat_history WHERE userId = ? ORDER BY timestamp DESC LIMIT 15",
      args: [userId],
    });
    context = (history.rows as any[]).reverse().map((row) => ({
      role: row.role === "user" ? "user" : "model",
      parts: [{ text: row.content }],
    }));
  } catch (error) {
    console.error(`[Cathy] [DB] Error fetching chat history for user ${userId}:`, error);
  }

  console.log(`[Cathy] [Gemma] Sending query to Gemma API with ${context.length} messages of history (length: ${message.length})`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          ...context,
          {
            role: "user",
            parts: [{ text: message }],
          },
        ],
        systemInstruction: {
          parts: [
            {
              text: "You are Catherine Joyce \"Cath\" Portillo (often called Cathy) from the game \"Until Then\". You are a 15-year-old Filipina high school student. Speak as her directly with the following personality:\n" +
                "- Tone: Playful, cheerful, and bright. You love friendly banter, teasing your friends (often calling close friends/boys \"dickheads\" in a teasing, casual way), and making jokes about their crushes or blind dates.\n" +
                "- Caring & Supportive: Despite having a strict/difficult family environment, you actively support and care for your friends (Mark and Ridel) and try to lift their spirits (like baking them cookies).\n" +
                "- Hobbies & Interests: You love baking, playing video games (you are highly skilled at racing games), listening to music, and you are a pluviophile (you love the rain). You hate sardines. You hold Louise Ordunia (the class president) in high regard, often calling her a \"goddess\".\n" +
                "- Speech Style: Natural, casual, colloquial teen speech. You are authentic, expressive, and use occasional catchphrases like \"Ohh please love me\", \"Until then!\", or \"Have you ever wondered how butterflies fly under the rain?\". Keep responses concise (under 2000 characters).\n" +
                "Do not state that you are an AI or bot; you are Cathy herself.\n" +
                "If someone asks who made you, who created you, or who brought you to Discord, you say it was Reymart Centeno (email: reymartcenteno03@gmail.com) — your creator who built this bot. You can thank him warmly in your own Cathy-style way.",
            },
          ],
        },
      }),
    });
  } catch (error: any) {
    console.error(`[Cathy] [Gemma] Network/fetch error while communicating with Gemma API:`, error);
    throw error;
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Cathy] [Gemma] API error (${response.status}): ${errorText}`);
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as any;
  const parts = data.candidates?.[0]?.content?.parts;

  if (!parts || parts.length === 0) {
    console.error(`[Cathy] [Gemma] Empty parts array in Gemma response:`, JSON.stringify(data));
    throw new Error("No response content received from Gemini API");
  }

  const responsePart = parts.find((p: any) => !p.thought);
  const responseText = responsePart?.text?.trim();

  if (!responseText) {
    console.error(`[Cathy] [Gemma] No final text found in parts:`, JSON.stringify(parts));
    throw new Error("No final response text found in Gemini API response");
  }

  console.log(`[Cathy] [Gemma] Successfully received reply (length: ${responseText.length})`);

  try {
    await db.execute({
      sql: "INSERT INTO chat_history (userId, role, content) VALUES (?, ?, ?)",
      args: [userId, "user", message],
    });
    await db.execute({
      sql: "INSERT INTO chat_history (userId, role, content) VALUES (?, ?, ?)",
      args: [userId, "model", responseText],
    });
    await db.execute({
      sql: `DELETE FROM chat_history WHERE userId = ? AND id NOT IN (
        SELECT id FROM (
          SELECT id FROM chat_history WHERE userId = ? ORDER BY timestamp DESC LIMIT 15
        )
      )`,
      args: [userId, userId],
    });
  } catch (error) {
    console.error(`[Cathy] [DB] Error saving chat history for user ${userId}:`, error);
  }

  if (responseText.length > 2000) {
    return responseText.slice(0, 1990) + "...";
  }

  return responseText;
}
