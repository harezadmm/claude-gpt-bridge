import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CodexAuth } from "../codex-auth.js";
import { CodexApiError, CodexClient } from "../codex-client.js";

function b64url(s: string): string {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const NOW = 1_800_000_000_000;
const TOKEN = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ exp: (NOW + 86_400_000) / 1000, "https://api.openai.com/auth": { chatgpt_account_id: "acc-x" } }))}.s`;

async function authFixture(fetchImpl?: typeof fetch): Promise<CodexAuth> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: TOKEN, refresh_token: "r" } }));
  return new CodexAuth({ codexHome: dir, now: () => NOW, fetchImpl });
}

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("generateImage sends the Codex request shape and extracts the image", async () => {
  const auth = await authFixture();
  let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
    return sse([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.image_generation_call.partial_image", partial_image_b64: "cGFydGlhbA==" },
      { type: "response.output_item.done", item: { type: "image_generation_call", result: "ZnVsbA==", revised_prompt: "a fox", output_format: "png" } },
      { type: "response.completed", response: { id: "resp_1" } },
    ]);
  }) as typeof fetch;
  const client = new CodexClient({ auth, fetchImpl });
  const res = await client.generateImage({
    prompt: "fox",
    hostModel: "gpt-5.6-luna",
    imageModel: "gpt-image-2",
    size: "1024x1024",
    quality: "low",
    refs: [{ mime: "image/png", base64: "QUJD" }],
  });
  assert.equal(res.imageBase64, "ZnVsbA==");
  assert.equal(res.revisedPrompt, "a fox");
  assert.equal(res.responseId, "resp_1");
  const c = captured!;
  assert.equal(c.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(c.headers["chatgpt-account-id"], "acc-x");
  assert.equal(c.headers["OpenAI-Beta"], "responses=experimental");
  assert.equal(c.headers.originator, "codex_cli_rs");
  assert.equal(c.body.model, "gpt-5.6-luna");
  assert.equal(c.body.store, false);
  assert.equal(c.body.stream, true);
  assert.deepEqual(c.body.tool_choice, { type: "image_generation" });
  assert.deepEqual(c.body.tools, [{ type: "image_generation", model: "gpt-image-2", quality: "low", size: "1024x1024" }]);
  const input = c.body.input as Array<{ content: Array<Record<string, unknown>> }>;
  assert.equal(input[0]!.content[0]!.type, "input_text");
  assert.equal(input[0]!.content[1]!.type, "input_image");
  assert.equal(input[0]!.content[1]!.image_url, "data:image/png;base64,QUJD");
});

test("size auto omits the size field and partial image is a fallback", async () => {
  const auth = await authFixture();
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return sse([
      { type: "response.image_generation_call.partial_image", partial_image_b64: "cGFydGlhbA==" },
      { type: "response.completed", response: {} },
    ]);
  }) as typeof fetch;
  const client = new CodexClient({ auth, fetchImpl });
  const res = await client.generateImage({ prompt: "x", hostModel: "h", imageModel: "i", size: "auto", quality: "medium" });
  assert.equal(res.imageBase64, "cGFydGlhbA==");
  assert.deepEqual(body.tools, [{ type: "image_generation", model: "i", quality: "medium" }]);
});

test("no image in stream throws with GPT's message", async () => {
  const auth = await authFixture();
  const fetchImpl = (async () =>
    sse([
      { type: "response.output_text.delta", delta: "I cannot " },
      { type: "response.output_text.delta", delta: "draw that." },
      { type: "response.completed", response: {} },
    ])) as typeof fetch;
  const client = new CodexClient({ auth, fetchImpl });
  await assert.rejects(
    () => client.generateImage({ prompt: "x", hostModel: "h", imageModel: "i", size: "1024x1024", quality: "low" }),
    (e: unknown) => e instanceof CodexApiError && /I cannot draw that/.test(e.message),
  );
});

test("401 triggers one refresh and retry", async () => {
  let calls = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: TOKEN, refresh_token: "r2" }), { status: 200 });
    }
    calls++;
    if (calls === 1) return new Response("expired", { status: 401 });
    return sse([
      { type: "response.output_text.delta", delta: "hello" },
      { type: "response.completed", response: {} },
    ]);
  }) as typeof fetch;
  const auth = await authFixture(fetchImpl);
  const client = new CodexClient({ auth, fetchImpl });
  const res = await client.ask({ prompt: "hi", hostModel: "h" });
  assert.equal(res.text, "hello");
  assert.equal(calls, 2);
});

test("429 maps to a quota message and ask sends history", async () => {
  const auth = await authFixture();
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response('{"error":"usage_limit_reached"}', { status: 429 });
  }) as typeof fetch;
  const client = new CodexClient({ auth, fetchImpl });
  await assert.rejects(
    () => client.ask({ prompt: "q", hostModel: "h", history: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }], reasoningEffort: "low" }),
    (e: unknown) => e instanceof CodexApiError && e.status === 429 && /Kuota/.test(e.message),
  );
  const input = body.input as Array<Record<string, unknown>>;
  assert.equal(input.length, 3);
  assert.equal(input[1]!.role, "assistant");
  assert.deepEqual(body.reasoning, { effort: "low" });
});
