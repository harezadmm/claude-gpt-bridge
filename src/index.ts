#!/usr/bin/env node
/**
 * claude-gpt-bridge — MCP server that lets Claude hand image generation and
 * questions to GPT through the Codex backend (ChatGPT subscription), with all
 * state kept per project folder under <project>/gpt-bridge/.
 *
 * stdout is the MCP channel: never console.log here, use log() (stderr).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { z } from "zod";
import { CodexAuth, CodexAuthError, planTypeFromJwt } from "./codex-auth.js";
import { CodexApiError, CodexClient, type ChatTurn, type RefImage } from "./codex-client.js";
import { ProjectStore, resolveProjectDir, type ProjectData, type StoreDefaults } from "./project-store.js";

const VERSION = "0.1.0";
const SIZES = ["1024x1024", "1536x1024", "1024x1536", "auto"] as const;
const QUALITIES = ["low", "medium", "high"] as const;
const FALLBACK_HOST_MODEL = "gpt-5.5";
const MAX_REF_BYTES = 15 * 1024 * 1024;
const MAX_REFS = 5;
const PREVIEW_PX = 512;
const HISTORY_TURNS = 6;

const DEFAULTS: StoreDefaults = {
  image_model: process.env.GPT_BRIDGE_IMAGE_MODEL ?? "gpt-image-2",
  host_model: process.env.GPT_BRIDGE_HOST_MODEL ?? "gpt-5.6-luna",
  default_size: process.env.GPT_BRIDGE_DEFAULT_SIZE ?? "1024x1024",
  default_quality: process.env.GPT_BRIDGE_DEFAULT_QUALITY ?? "medium",
};

const log = (msg: string): void => {
  process.stderr.write(`[gpt-bridge] ${msg}\n`);
};

const auth = new CodexAuth();
const client = new CodexClient({ auth, log });

function text(t: string): CallToolResult {
  return { content: [{ type: "text", text: t }] };
}

function errorResult(err: unknown): CallToolResult {
  let msg: string;
  if (err instanceof CodexAuthError || err instanceof CodexApiError) msg = err.message;
  else if (err instanceof Error) msg = `${err.name}: ${err.message}`;
  else msg = String(err);
  log(`error: ${msg}`);
  return { content: [{ type: "text", text: `❌ ${msg}` }], isError: true };
}

function openStore(projectDir: string | undefined): ProjectStore {
  return new ProjectStore(resolveProjectDir(projectDir), DEFAULTS);
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

async function readRefs(paths: string[] | undefined, root: string): Promise<{ refs: RefImage[]; names: string[] }> {
  const refs: RefImage[] = [];
  const names: string[] = [];
  if (!paths || paths.length === 0) return { refs, names };
  if (paths.length > MAX_REFS) throw new Error(`Maksimal ${MAX_REFS} gambar referensi, diberikan ${paths.length}.`);
  for (const p of paths) {
    const abs = path.resolve(root, p);
    const mime = MIME_BY_EXT[path.extname(abs).toLowerCase()];
    if (!mime) throw new Error(`Referensi ${p}: hanya png/jpg/webp yang didukung.`);
    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch {
      throw new Error(`Referensi tidak ditemukan: ${abs}`);
    }
    if (buf.byteLength > MAX_REF_BYTES) throw new Error(`Referensi ${p} lebih dari 15 MB, kecilkan dulu.`);
    refs.push({ mime, base64: buf.toString("base64") });
    names.push(path.relative(root, abs).split(path.sep).join("/"));
  }
  return { refs, names };
}

async function makePreview(png: Buffer): Promise<{ data: string; mimeType: string } | null> {
  try {
    const out = await sharp(png)
      .resize({ width: PREVIEW_PX, height: PREVIEW_PX, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
    return { data: out.toString("base64"), mimeType: "image/jpeg" };
  } catch (err) {
    log(`preview gagal: ${(err as Error).message}`);
    return null;
  }
}

function composeImagePrompt(brief: string | null, prompt: string, useBrief: boolean): string {
  if (!useBrief || !brief) return prompt;
  return `Project brief (style and context to respect):\n${brief.trim()}\n\nImage request:\n${prompt}`;
}

function composeAskInstructions(brief: string | null, projectName: string): string {
  const base =
    "You are GPT, consulted by Claude (another AI assistant) that is working on a project with the user. " +
    "Answer directly and concretely; skip pleasantries.";
  if (!brief) return `${base}\nProject: ${projectName}.`;
  return `${base}\nProject: ${projectName}.\nProject brief:\n${brief.trim()}`;
}

interface ImageArgs {
  prompt: string;
  size: string;
  quality: string;
  refs: RefImage[];
  refNames: string[];
  filename?: string;
  useBrief: boolean;
  noPreview: boolean;
}

async function runImage(store: ProjectStore, data: ProjectData, args: ImageArgs): Promise<CallToolResult> {
  const brief = await store.readBrief();
  const fullPrompt = composeImagePrompt(brief, args.prompt, args.useBrief);
  const hostCandidates = [data.settings.host_model, FALLBACK_HOST_MODEL].filter((m, i, a) => a.indexOf(m) === i);

  let result: Awaited<ReturnType<CodexClient["generateImage"]>> | null = null;
  let lastErr: unknown = null;
  for (const hostModel of hostCandidates) {
    try {
      log(
        `generate_image host=${hostModel} image=${data.settings.image_model} size=${args.size} quality=${args.quality} refs=${args.refs.length}`,
      );
      result = await client.generateImage({
        prompt: fullPrompt,
        hostModel,
        imageModel: data.settings.image_model,
        size: args.size,
        quality: args.quality,
        refs: args.refs,
      });
      break;
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof CodexApiError && err.status === 400 && /model/i.test(err.body);
      if (!retryable) throw err;
      log(`host model ${hostModel} ditolak, coba ${FALLBACK_HOST_MODEL}`);
    }
  }
  if (!result) throw lastErr ?? new Error("Generate gagal tanpa detail.");

  const ext = result.outputFormat === "jpeg" ? "jpg" : result.outputFormat === "webp" ? "webp" : "png";
  const { abs, rel, id } = await store.nextImagePath(data, args.prompt, ext, args.filename);
  const bytes = Buffer.from(result.imageBase64, "base64");
  await fs.writeFile(abs, bytes);
  store.appendHistory(data, {
    kind: "image",
    prompt: args.prompt,
    file: rel,
    size: args.size,
    quality: args.quality,
    refs: args.refNames.length ? args.refNames : undefined,
    model: data.settings.image_model,
  });
  await store.save(data);

  const lines = [
    `✅ Gambar tersimpan: ${abs}`,
    `Proyek: ${data.name} (${store.root}) · gambar #${id} · ${args.size} ${args.quality} · ${data.settings.image_model} · ${(bytes.byteLength / 1024).toFixed(0)} KB`,
  ];
  if (args.refNames.length) lines.push(`Referensi: ${args.refNames.join(", ")}`);
  if (result.revisedPrompt && result.revisedPrompt !== args.prompt) lines.push(`Revised prompt: ${result.revisedPrompt}`);
  if (result.text.trim()) lines.push(`Catatan GPT: ${result.text.trim().slice(0, 500)}`);

  const content: CallToolResult["content"] = [{ type: "text", text: lines.join("\n") }];
  if (!args.noPreview) {
    const preview = await makePreview(bytes);
    if (preview) content.push({ type: "image", data: preview.data, mimeType: preview.mimeType });
  }
  return { content };
}

const server = new McpServer(
  { name: "claude-gpt-bridge", version: VERSION },
  {
    instructions:
      "Bridge from Claude to GPT (ChatGPT subscription via Codex). State is per project folder: pass project_dir as the " +
      "absolute path of the folder you are working in. Use project_init once to give GPT a brief (style, palette, subject); " +
      "generate_image / edit_image render with gpt-image-2 and save PNGs under <project>/gpt-bridge/images/; ask_gpt asks GPT " +
      "a text question with the project brief and recent exchanges as context.",
  },
);

const projectDirSchema = z
  .string()
  .optional()
  .describe("Absolute path of the project folder Claude is working in. Defaults to the server's working directory.");

server.registerTool(
  "project_init",
  {
    title: "Init GPT project in folder",
    description:
      "Create or update the GPT-side project for a folder: writes <project>/gpt-bridge/project.json and brief.md. " +
      "The brief is prepended to every image prompt and ask_gpt call, so put style, palette, subject, and constraints there.",
    inputSchema: {
      project_dir: projectDirSchema,
      name: z.string().optional().describe("Project name. Defaults to the folder name."),
      brief: z.string().optional().describe("Markdown brief for GPT. Replaces the existing brief when given."),
      host_model: z.string().optional().describe("Override the GPT host model slug for this project."),
      image_model: z.string().optional().describe("Override the image model for this project (default gpt-image-2)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ project_dir, name, brief, host_model, image_model }) => {
    try {
      const store = openStore(project_dir);
      const data = await store.load(name);
      if (host_model) data.settings.host_model = host_model;
      if (image_model) data.settings.image_model = image_model;
      if (brief !== undefined) await store.writeBrief(brief);
      await store.save(data);
      const currentBrief = await store.readBrief();
      return text(
        [
          `✅ Proyek GPT siap: ${data.name}`,
          `Folder: ${store.dir}`,
          `Brief: ${currentBrief ? `${currentBrief.trim().length} karakter (${store.briefFile})` : "belum ada, isi lewat parameter brief"}`,
          `Model: host ${data.settings.host_model}, image ${data.settings.image_model}`,
          `Riwayat: ${data.history.length} entri, ${data.counter} gambar dibuat`,
        ].join("\n"),
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "project_status",
  {
    title: "GPT project status",
    description:
      "Show the GPT-side project for a folder: brief, settings, recent images and questions, and the ChatGPT login state.",
    inputSchema: { project_dir: projectDirSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ project_dir }) => {
    try {
      const store = openStore(project_dir);
      const exists = await store.exists();
      const data = await store.load();
      const brief = await store.readBrief();
      let login = "tidak diketahui";
      try {
        const file = await auth.read();
        const token = file.tokens?.access_token;
        login = token
          ? `login ChatGPT (${planTypeFromJwt(token) ?? "plan ?"}), refresh terakhir ${file.last_refresh ?? "?"}`
          : `auth_mode=${file.auth_mode ?? "?"} tanpa sesi ChatGPT`;
      } catch (err) {
        login = (err as Error).message;
      }
      const recent = data.history.slice(-10).map((h) => {
        const when = h.at.slice(0, 16).replace("T", " ");
        return h.kind === "image"
          ? `  #${h.id} [image] ${when} ${h.file} — ${h.prompt.slice(0, 80)}`
          : `  #${h.id} [ask]   ${when} ${h.prompt.slice(0, 80)}`;
      });
      return text(
        [
          `Proyek: ${data.name}${exists ? "" : " (baru dibuat)"}`,
          `Root: ${store.root}`,
          `Folder bridge: ${store.dir}`,
          `Codex: ${login}`,
          `Model: host ${data.settings.host_model}, image ${data.settings.image_model}; default ${data.settings.default_size} ${data.settings.default_quality}`,
          `Gambar dibuat: ${data.counter} · entri riwayat: ${data.history.length}`,
          `Brief: ${brief ? brief.trim().slice(0, 600) : "(kosong)"}`,
          recent.length ? `Riwayat terakhir:\n${recent.join("\n")}` : "Riwayat: kosong",
        ].join("\n"),
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

const imageInputBase = {
  prompt: z
    .string()
    .min(1)
    .describe("Dense, art-directed prompt in English. Mention subject, style, lighting, camera, background, and what to avoid."),
  project_dir: projectDirSchema,
  size: z.enum(SIZES).optional().describe("Output size. Defaults to the project default (1024x1024)."),
  quality: z.enum(QUALITIES).optional().describe("low (~45s), medium (~1-2 min, default), high (~2-3 min)."),
  filename: z.string().optional().describe("Base file name without extension. Defaults to NNN-<slug of prompt>."),
  use_brief: z.boolean().optional().describe("Prepend the project brief to the prompt (default true)."),
  no_preview: z.boolean().optional().describe("Skip the inline preview image in the result (saves tokens)."),
};

server.registerTool(
  "generate_image",
  {
    title: "Generate image with GPT",
    description:
      "Generate an image with gpt-image-2 through the ChatGPT subscription and save it as PNG under <project>/gpt-bridge/images/. " +
      "Returns the absolute file path plus a small inline preview so you can judge the result and iterate. " +
      "Optional refs (up to 5 local png/jpg/webp paths) carry character, style, or logo into the new image.",
    inputSchema: {
      ...imageInputBase,
      refs: z.array(z.string()).max(MAX_REFS).optional().describe("Reference image paths (absolute or relative to project_dir)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args) => {
    try {
      const store = openStore(args.project_dir);
      const data = await store.load();
      const { refs, names } = await readRefs(args.refs, store.root);
      return await runImage(store, data, {
        prompt: args.prompt,
        size: args.size ?? data.settings.default_size,
        quality: args.quality ?? data.settings.default_quality,
        refs,
        refNames: names,
        filename: args.filename,
        useBrief: args.use_brief ?? true,
        noPreview: args.no_preview ?? false,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "edit_image",
  {
    title: "Edit or iterate an image with GPT",
    description:
      "Produce a new image from one or more existing images (previous generations or any local file) plus an instruction, " +
      "e.g. 'same icon but in the blue palette from the brief'. Same output and preview as generate_image.",
    inputSchema: {
      ...imageInputBase,
      refs: z.array(z.string()).min(1).max(MAX_REFS).describe("Source image paths (absolute or relative to project_dir). Required."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args) => {
    try {
      const store = openStore(args.project_dir);
      const data = await store.load();
      const { refs, names } = await readRefs(args.refs, store.root);
      return await runImage(store, data, {
        prompt: args.prompt,
        size: args.size ?? data.settings.default_size,
        quality: args.quality ?? data.settings.default_quality,
        refs,
        refNames: names,
        filename: args.filename,
        useBrief: args.use_brief ?? true,
        noPreview: args.no_preview ?? false,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "ask_gpt",
  {
    title: "Ask GPT (text)",
    description:
      "Send a text question to GPT with the project brief and the last few exchanges as context. Use it for a second opinion, " +
      "a prompt rewrite, or a review. The exchange is stored in the project history.",
    inputSchema: {
      prompt: z.string().min(1).describe("The question or task for GPT."),
      project_dir: projectDirSchema,
      use_history: z.boolean().optional().describe("Include the last 6 ask_gpt exchanges as context (default true)."),
      use_brief: z.boolean().optional().describe("Include the project brief in the instructions (default true)."),
      reasoning_effort: z
        .enum(["low", "medium", "high"])
        .optional()
        .describe("Reasoning effort for the host model. Omit for the backend default."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ prompt, project_dir, use_history, use_brief, reasoning_effort }) => {
    try {
      const store = openStore(project_dir);
      const data = await store.load();
      const brief = use_brief === false ? null : await store.readBrief();
      const history: ChatTurn[] = [];
      if (use_history !== false) {
        for (const h of store.recentAsks(data, HISTORY_TURNS)) {
          history.push({ role: "user", text: h.prompt });
          history.push({ role: "assistant", text: h.answer ?? "" });
        }
      }
      log(`ask_gpt host=${data.settings.host_model} history=${history.length / 2}`);
      const res = await client.ask({
        prompt,
        hostModel: data.settings.host_model,
        instructions: composeAskInstructions(brief, data.name),
        history,
        reasoningEffort: reasoning_effort ?? process.env.GPT_BRIDGE_REASONING_EFFORT,
      });
      const entry = store.appendHistory(data, { kind: "ask", prompt, answer: res.text, model: data.settings.host_model });
      await store.save(data);
      return text(`GPT (${data.settings.host_model}, riwayat #${entry.id}):\n\n${res.text}`);
    } catch (err) {
      return errorResult(err);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready v${VERSION} cwd=${process.cwd()} host=${DEFAULTS.host_model} image=${DEFAULTS.image_model}`);
}

main().catch((err) => {
  log(`fatal: ${(err as Error).stack ?? String(err)}`);
  process.exit(1);
});
