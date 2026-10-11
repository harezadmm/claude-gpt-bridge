/**
 * Per-folder project state for the bridge.
 * Everything lives under <project_dir>/gpt-bridge/ so the GPT side of a project
 * travels with the folder Claude is working in.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const BRIDGE_DIRNAME = "gpt-bridge";
export const IMAGES_DIRNAME = "images";
export const PROJECT_FILE = "project.json";
export const BRIEF_FILE = "brief.md";
const MAX_HISTORY = 200;
const MAX_ANSWER_CHARS = 4000;

export interface HistoryEntry {
  id: number;
  kind: "image" | "ask";
  prompt: string;
  at: string;
  file?: string; // relative to project root, forward slashes
  size?: string;
  quality?: string;
  refs?: string[];
  answer?: string;
  model?: string;
}

export interface ProjectSettings {
  image_model: string;
  host_model: string;
  default_size: string;
  default_quality: string;
}

export interface ProjectData {
  name: string;
  created: string;
  counter: number;
  settings: ProjectSettings;
  history: HistoryEntry[];
}

export type StoreDefaults = ProjectSettings;

export function resolveProjectDir(input: string | undefined, cwd: string = process.cwd()): string {
  if (!input || input.trim() === "") return path.resolve(cwd);
  return path.resolve(cwd, input);
}

export function slugify(text: string, maxLen = 40): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return s || "image";
}

export class ProjectStore {
  readonly root: string;
  readonly dir: string;
  readonly imagesDir: string;
  private readonly defaults: StoreDefaults;

  constructor(root: string, defaults: StoreDefaults) {
    this.root = path.resolve(root);
    this.dir = path.join(this.root, BRIDGE_DIRNAME);
    this.imagesDir = path.join(this.dir, IMAGES_DIRNAME);
    this.defaults = defaults;
  }

  get projectFile(): string {
    return path.join(this.dir, PROJECT_FILE);
  }

  get briefFile(): string {
    return path.join(this.dir, BRIEF_FILE);
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.projectFile);
      return true;
    } catch {
      return false;
    }
  }

  /** Load project.json, creating the folder and file when missing. */
  async load(name?: string): Promise<ProjectData> {
    await fs.mkdir(this.imagesDir, { recursive: true });
    let data: ProjectData | null = null;
    try {
      const raw = await fs.readFile(this.projectFile, "utf8");
      data = JSON.parse(raw) as ProjectData;
    } catch {
      data = null;
    }
    if (!data) {
      data = {
        name: name ?? path.basename(this.root),
        created: new Date().toISOString(),
        counter: 0,
        settings: { ...this.defaults },
        history: [],
      };
      await this.save(data);
    } else {
      // Backfill fields added after the file was created.
      data.settings = { ...this.defaults, ...(data.settings ?? {}) };
      data.history = Array.isArray(data.history) ? data.history : [];
      if (typeof data.counter !== "number") data.counter = 0;
      if (name && name !== data.name) {
        data.name = name;
        await this.save(data);
      }
    }
    return data;
  }

  async save(data: ProjectData): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.projectFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    await fs.rename(tmp, this.projectFile);
  }

  async readBrief(): Promise<string | null> {
    try {
      const text = await fs.readFile(this.briefFile, "utf8");
      return text.trim() === "" ? null : text;
    } catch {
      return null;
    }
  }

  async writeBrief(text: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.briefFile, text.endsWith("\n") ? text : text + "\n", "utf8");
  }

  /**
   * Reserve the next image path. Increments the counter and persists it so two
   * sequential calls never collide. Returns absolute path and project-relative path.
   */
  async nextImagePath(
    data: ProjectData,
    hint: string,
    ext = "png",
    explicitName?: string,
  ): Promise<{ abs: string; rel: string; id: number }> {
    data.counter += 1;
    const id = data.counter;
    const base = explicitName
      ? explicitName.replace(/\.(png|jpe?g|webp)$/i, "")
      : `${String(id).padStart(3, "0")}-${slugify(hint)}`;
    const abs = path.join(this.imagesDir, `${base}.${ext}`);
    const rel = path.relative(this.root, abs).split(path.sep).join("/");
    await this.save(data);
    return { abs, rel, id };
  }

  appendHistory(
    data: ProjectData,
    entry: Omit<HistoryEntry, "id" | "at"> & { id?: number },
  ): HistoryEntry {
    const last = data.history[data.history.length - 1];
    const id = entry.id ?? (last ? last.id + 1 : 1);
    const full: HistoryEntry = {
      ...entry,
      id,
      at: new Date().toISOString(),
      answer: entry.answer ? entry.answer.slice(0, MAX_ANSWER_CHARS) : undefined,
    };
    data.history.push(full);
    if (data.history.length > MAX_HISTORY) {
      data.history.splice(0, data.history.length - MAX_HISTORY);
    }
    return full;
  }

  /** Last N question/answer pairs, oldest first, for conversational context. */
  recentAsks(data: ProjectData, turns: number): HistoryEntry[] {
    return data.history.filter((h) => h.kind === "ask" && h.answer).slice(-turns);
  }

  recentImages(data: ProjectData, n: number): HistoryEntry[] {
    return data.history.filter((h) => h.kind === "image" && h.file).slice(-n);
  }
}
