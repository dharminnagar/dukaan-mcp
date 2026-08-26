/**
 * Plain-`fetch` OpenRouter chat call, mirroring `src/eval/llm-generate.ts`'s
 * `callOpenRouterChat`: no SDK, model id and base URL from env with the same
 * documented fallback, never throws for an API-level failure (returned as
 * `{ ok: false }` data instead), and the key is never logged.
 *
 * Server-only: this module is only ever imported from app/actions.ts.
 */
import "./assert-server-only";

const DEFAULT_MODEL = "z-ai/glm-5.3-flash";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function optionalEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v;
}

export interface OpenRouterChatDeps {
  /** Defaults to the global `fetch`. Tests inject a stub — never hit the live API from `bun test`. */
  readonly fetch?: typeof fetch;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

export type OpenRouterChatResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

interface OpenRouterResponseBody {
  choices?: readonly { message?: { content?: unknown } }[];
}

export async function callOpenRouterChat(
  prompt: string,
  deps: OpenRouterChatDeps
): Promise<OpenRouterChatResult> {
  const fetchFn = deps.fetch ?? fetch;

  let response: Response;
  try {
    response = await fetchFn(`${deps.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: deps.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: `network error calling OpenRouter: ${(err as Error).message}`,
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      error: `OpenRouter returned HTTP ${response.status}${text ? `: ${text}` : ""}`,
    };
  }

  let body: OpenRouterResponseBody;
  try {
    body = (await response.json()) as OpenRouterResponseBody;
  } catch (err) {
    return {
      ok: false,
      error: `OpenRouter response was not valid JSON: ${(err as Error).message}`,
    };
  }

  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, error: "OpenRouter response had no message content" };
  }
  return { ok: true, text: content };
}

/**
 * Reads OPENROUTER_API_KEY/MODEL/BASE_URL from the environment. Returns
 * `null` for the key when unset — callers use that as the "no key" branch
 * of the fallback rule, never throwing just because a judge didn't set one.
 */
export function readOpenRouterEnv(): {
  apiKey: string | null;
  model: string;
  baseUrl: string;
} {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  return {
    apiKey: apiKey === undefined || apiKey.trim() === "" ? null : apiKey,
    model: optionalEnv("OPENROUTER_MODEL", DEFAULT_MODEL),
    baseUrl: optionalEnv("OPENROUTER_BASE_URL", DEFAULT_BASE_URL),
  };
}
