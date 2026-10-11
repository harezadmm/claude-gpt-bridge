/**
 * Thin client for the Codex backend (Responses API over SSE) that the Codex CLI
 * itself uses. Two operations: image generation via the image_generation tool,
 * and plain text questions.
 */
import { CodexAuth } from "./codex-auth.js";
import { parseSse, sseJson } from "./sse.js";

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export const IMAGE_INSTRUCTIONS =
  "You are an image generation bridge. Fulfil every request by calling the image_generation tool exactly once, " +
  "passing the user's prompt faithfully. Do not add commentary before or after the image.";

export const ASK_INSTRUCTIONS =
  "You are GPT, consulted by another AI assistant (Claude) that is working on a software or design project. " +
  "Answer directly and concretely. Use the project brief and prior exchanges as context when provided.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEvent = Record<string, any>;

export class CodexApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Codex backend ${status}: ${body.slice(0, 300)}`);
    this.name = "CodexApiError";
    this.status = status;
    this.body = body;
  }
}

export interface RefImage {
  mime: string;
  base64: string;
}

export interface ImageRequest {
  prompt: string;
  hostModel: string;
  imageModel: string;
  size: string;
  quality: string;
  refs?: RefImage[];
  instructions?: string;
}

export interface ImageResult {
  imageBase64: string;
  outputFormat: string;
  text: string;
  revisedPrompt?: string;
  responseId?: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AskRequest {
  prompt: string;
  hostModel: string;
  instructions?: string;
  history?: ChatTurn[];
  reasoningEffort?: string;
}

export interface AskResult {
  text: string;
  responseId?: string;
}

export interface CodexClientOptions {
  auth: CodexAuth;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  log?: (msg: string) => void;
}

function friendlyMessage(status: number, text: string): string {
  const snippet = text.replace(/\s+/g, " ").slice(0, 300);
  switch (status) {
    case 401:
      return "Sesi ChatGPT ditolak (401) walau sudah di-refresh. Jalankan `codex login` lalu coba lagi.";
    case 403:
      return `Akses ditolak (403). Akun mungkin tidak punya entitlement image generation di Codex. Detail: ${snippet}`;
    case 429:
      return `Kuota ChatGPT/Codex habis atau rate limit (429). Tunggu reset kuota. Detail: ${snippet}`;
    case 400:
      return `Permintaan ditolak backend Codex (400): ${snippet}`;
    default:
      return `Backend Codex menjawab ${status}: ${snippet}`;
  }
}

function extractMessageText(item: AnyEvent): string {
  const content = Array.isArray(item?.content) ? item.content : [];
  return content
    .map((c: AnyEvent) => (typeof c?.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("");
}

export class CodexClient {
  private readonly auth: CodexAuth;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly log: (msg: string) => void;

  constructor(opts: CodexClientOptions) {
    this.auth = opts.auth;
    this.baseUrl = (opts.baseUrl ?? process.env.GPT_BRIDGE_CODEX_BASE_URL ?? CODEX_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.GPT_BRIDGE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent = opts.userAgent ?? "claude-gpt-bridge/0.1.0";
    this.log = opts.log ?? (() => {});
  }

  async generateImage(req: ImageRequest): Promise<ImageResult> {
    const content: AnyEvent[] = [{ type: "input_text", text: req.prompt }];
    for (const ref of req.refs ?? []) {
      content.push({
        type: "input_image",
        image_url: `data:${ref.mime};base64,${ref.base64}`,
        detail: "auto",
      });
    }
    const tool: AnyEvent = { type: "image_generation", model: req.imageModel, quality: req.quality };
    if (req.size && req.size !== "auto") tool.size = req.size;
    const body = {
      model: req.hostModel,
      instructions: req.instructions ?? IMAGE_INSTRUCTIONS,
      input: [{ type: "message", role: "user", content }],
      tools: [tool],
      tool_choice: { type: "image_generation" },
      store: false,
      stream: true,
    };

    let result = "";
    let partial = "";
    let text = "";
    let revisedPrompt: string | undefined;
    let outputFormat = "png";
    let responseId: string | undefined;

    for await (const ev of this.stream(body)) {
      switch (ev.type) {
        case "response.created":
          responseId = ev.response?.id;
          break;
        case "response.output_text.delta":
          text += typeof ev.delta === "string" ? ev.delta : "";
          break;
        case "response.image_generation_call.partial_image":
          if (typeof ev.partial_image_b64 === "string") partial = ev.partial_image_b64;
          break;
        case "response.output_item.done": {
          const item = ev.item ?? {};
          if (item.type === "image_generation_call") {
            if (typeof item.result === "string" && item.result.length > 0) result = item.result;
            if (typeof item.revised_prompt === "string") revisedPrompt = item.revised_prompt;
            if (typeof item.output_format === "string") outputFormat = item.output_format;
          } else if (item.type === "message" && text === "") {
            text = extractMessageText(item);
          }
          break;
        }
        case "response.failed": {
          const msg = ev.response?.error?.message ?? "unknown";
          throw new CodexApiError(0, JSON.stringify(ev.response?.error ?? ev), `GPT gagal memproses: ${msg}`);
        }
        case "error": {
          const msg = ev.message ?? ev.error?.message ?? "unknown";
          throw new CodexApiError(0, JSON.stringify(ev), `Backend Codex mengirim error: ${msg}`);
        }
        default:
          break;
      }
    }

    const imageBase64 = result || partial;
    if (!imageBase64) {
      const hint = text ? ` Pesan GPT: ${text.slice(0, 500)}` : "";
      throw new CodexApiError(0, text, `GPT tidak mengembalikan gambar.${hint}`);
    }
    return { imageBase64, outputFormat, text, revisedPrompt, responseId };
  }

  async ask(req: AskRequest): Promise<AskResult> {
    const input: AnyEvent[] = [];
    for (const turn of req.history ?? []) {
      input.push(
        turn.role === "user"
          ? { type: "message", role: "user", content: [{ type: "input_text", text: turn.text }] }
          : { type: "message", role: "assistant", content: [{ type: "output_text", text: turn.text }] },
      );
    }
    input.push({ type: "message", role: "user", content: [{ type: "input_text", text: req.prompt }] });
    const body: AnyEvent = {
      model: req.hostModel,
      instructions: req.instructions ?? ASK_INSTRUCTIONS,
      input,
      store: false,
      stream: true,
    };
    if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort };

    let text = "";
    let finalText = "";
    let responseId: string | undefined;
    for await (const ev of this.stream(body)) {
      switch (ev.type) {
        case "response.created":
          responseId = ev.response?.id;
          break;
        case "response.output_text.delta":
          text += typeof ev.delta === "string" ? ev.delta : "";
          break;
        case "response.output_item.done": {
          const item = ev.item ?? {};
          if (item.type === "message") finalText += extractMessageText(item);
          break;
        }
        case "response.failed": {
          const msg = ev.response?.error?.message ?? "unknown";
          throw new CodexApiError(0, JSON.stringify(ev.response?.error ?? ev), `GPT gagal menjawab: ${msg}`);
        }
        case "error": {
          const msg = ev.message ?? ev.error?.message ?? "unknown";
          throw new CodexApiError(0, JSON.stringify(ev), `Backend Codex mengirim error: ${msg}`);
        }
        default:
          break;
      }
    }
    const answer = finalText || text;
    if (!answer) throw new CodexApiError(0, "", "GPT mengembalikan jawaban kosong.");
    return { text: answer, responseId };
  }

  private async *stream(body: unknown): AsyncGenerator<AnyEvent> {
    let creds = await this.auth.getCredentials();
    let res = await this.post(body, creds);
    if (res.status === 401) {
      this.log("401 dari backend Codex, refresh sesi lalu ulang");
      creds = await this.auth.getCredentials({ forceRefresh: true });
      res = await this.post(body, creds);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new CodexApiError(res.status, text, friendlyMessage(res.status, text));
    }
    if (!res.body) throw new CodexApiError(res.status, "", "Backend Codex menjawab tanpa body.");
    for await (const msg of parseSse(res.body)) {
      const json = sseJson(msg);
      if (json && typeof json === "object") yield json as AnyEvent;
    }
  }

  private post(body: unknown, creds: { accessToken: string; accountId?: string }): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      "User-Agent": this.userAgent,
    };
    if (creds.accountId) headers["chatgpt-account-id"] = creds.accountId;
    return this.fetchImpl(`${this.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}
