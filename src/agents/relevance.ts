import { PureChatLLMChat } from '../core/Chat';
import type PureChatLLM from '../main';

const STOP = new Set(
  'about after again also because been before being could does doing from have just like more most much need only other over really should some than that them then there these they this those very want what when where which while will with would your'.split(
    ' ',
  ),
);

/** Salient words of a text (four letters or more, no common words). */
function salient(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length >= 4 && !STOP.has(w)),
  );
}

/**
 * Keyword check: does the update share enough salient words with what the user is saying?
 * @param update - Update text.
 * @param userText - What the user said most recently.
 */
export function keywordRelevant(update: string, userText: string): boolean {
  const a = salient(update);
  const b = salient(userText);
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const w of b) if (a.has(w)) shared++;
  return shared >= 2 || shared / b.size >= 0.3;
}

/**
 * Decides whether a background update should cut in on what the user is saying.
 *
 * Hani's rule, on top of GPT-Live's duplex timing: interrupt only when the update would overrule
 * or drastically change the point the user is making; otherwise let them finish the thought and
 * mention it at the next natural opening. `model` asks the sub-agent model for a one-word verdict
 * (with a short timeout and the keyword check as fallback); `keywords` is deterministic.
 * @param plugin - Plugin.
 * @param update - Update text.
 * @param userText - What the user said in the last few seconds.
 * @param mode - Check to run.
 */
export async function shouldInterrupt(
  plugin: PureChatLLM,
  update: string,
  userText: string,
  mode: 'model' | 'keywords' | 'off',
): Promise<boolean> {
  if (mode === 'off' || !userText.trim()) return false;
  const fallback = keywordRelevant(update, userText);
  if (mode === 'keywords') return fallback;
  try {
    const chat = new PureChatLLMChat(plugin);
    const model = plugin.settings.orchestrator.subAgentModel.trim() || chat.endpoint.defaultmodel;
    const verdict = chat.llmService
      .fetchResponse(chat.endpoint, {
        model,
        stream: false,
        max_completion_tokens: 16,
        messages: [
          {
            role: 'system',
            content:
              'You decide whether a background update should interrupt a person mid-sentence. Answer INTERRUPT only if the update would overrule, contradict or drastically change the point they are making right now. Otherwise answer WAIT. Reply with one word.',
          },
          {
            role: 'user',
            content: `They are saying: "${userText.slice(-600)}"\n\nUpdate: "${update.slice(0, 900)}"`,
          },
        ],
      })
      .then(r => /interrupt/i.test(r.content ?? ''));
    const timeout = new Promise<boolean>(resolve =>
      window.setTimeout(() => resolve(fallback), 3500),
    );
    return await Promise.race([verdict, timeout]);
  } catch {
    return fallback;
  }
}
