/**
 * Reads the ChatGPT-subscription OAuth tokens that `codex login` stores in
 * ~/.codex/auth.json and refreshes them when they are about to expire.
 * Nothing here ever logs token values.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Public OAuth client id used by the Codex CLI. Override with GPT_BRIDGE_OAUTH_CLIENT_ID. */
export const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_REFRESH_SKEW_MS = 10 * 60 * 1000;

export class CodexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAuthError";
  }
}

export interface CodexTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

export interface AuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: CodexTokens;
  last_refresh?: string;
  [key: string]: unknown;
}

export interface CodexAuthOptions {
  codexHome?: string;
  clientId?: string;
  issuer?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  refreshSkewMs?: number;
}

export interface Credentials {
  accessToken: string;
  accountId?: string;
}

function b64urlDecode(s: string): string {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  t += "=".repeat((4 - (t.length % 4)) % 4);
  return Buffer.from(t, "base64").toString("utf8");
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(b64urlDecode(parts[1]!)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function jwtExpiryMs(token: string): number | null {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : null;
}

export function accountIdFromJwt(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const id = auth?.chatgpt_account_id;
  return typeof id === "string" ? id : undefined;
}

export function planTypeFromJwt(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const plan = auth?.chatgpt_plan_type;
  return typeof plan === "string" ? plan : undefined;
}

export function defaultCodexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export class CodexAuth {
  readonly codexHome: string;
  readonly authFile: string;
  private readonly clientId: string;
  private readonly issuer: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;
  private refreshing: Promise<AuthFile> | null = null;

  constructor(opts: CodexAuthOptions = {}) {
    this.codexHome = opts.codexHome ?? defaultCodexHome();
    this.authFile = path.join(this.codexHome, "auth.json");
    this.clientId = opts.clientId ?? process.env.GPT_BRIDGE_OAUTH_CLIENT_ID ?? DEFAULT_CLIENT_ID;
    this.issuer = (opts.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.refreshSkewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  }

  async read(): Promise<AuthFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.authFile, "utf8");
    } catch {
      throw new CodexAuthError(
        `Codex belum login: ${this.authFile} tidak ada. Jalankan \`codex login\` (login pakai akun ChatGPT).`,
      );
    }
    try {
      return JSON.parse(raw) as AuthFile;
    } catch {
      throw new CodexAuthError(`${this.authFile} bukan JSON valid. Jalankan \`codex login\` ulang.`);
    }
  }

  /** Returns a usable access token, refreshing first when it is stale. */
  async getCredentials(opts: { forceRefresh?: boolean } = {}): Promise<Credentials> {
    let file = await this.read();
    const token = file.tokens?.access_token;
    if (!token) {
      throw new CodexAuthError(
        `auth.json tidak berisi token ChatGPT (auth_mode=${file.auth_mode ?? "?"}). Jalankan \`codex login\` dan pilih "Sign in with ChatGPT".`,
      );
    }
    const exp = jwtExpiryMs(token);
    const stale = exp !== null && exp - this.now() < this.refreshSkewMs;
    if (opts.forceRefresh || stale) {
      file = await this.refresh(file);
    }
    const tokens = file.tokens ?? {};
    const accessToken = tokens.access_token!;
    return {
      accessToken,
      accountId: tokens.account_id ?? accountIdFromJwt(accessToken),
    };
  }

  /** Refresh tokens; concurrent callers share one in-flight refresh. */
  refresh(file?: AuthFile): Promise<AuthFile> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(file).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(fileIn?: AuthFile): Promise<AuthFile> {
    const file = fileIn ?? (await this.read());
    const refreshToken = file.tokens?.refresh_token;
    if (!refreshToken) {
      throw new CodexAuthError("Token kedaluwarsa dan auth.json tidak punya refresh_token. Jalankan `codex login`.");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.clientId,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.issuer}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
      });
    } catch (err) {
      throw new CodexAuthError(`Refresh token gagal (jaringan): ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new CodexAuthError(`Refresh token ditolak (${res.status}). Jalankan \`codex login\`. Detail: ${text}`);
    }
    const json = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
    if (!json.access_token) {
      throw new CodexAuthError("Refresh token: server tidak mengembalikan access_token.");
    }
    const next: AuthFile = {
      ...file,
      tokens: {
        ...(file.tokens ?? {}),
        access_token: json.access_token,
        refresh_token: json.refresh_token ?? refreshToken,
        id_token: json.id_token ?? file.tokens?.id_token,
      },
      last_refresh: new Date(this.now()).toISOString(),
    };
    await this.write(next);
    return next;
  }

  private async write(file: AuthFile): Promise<void> {
    const tmp = `${this.authFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, this.authFile);
  }
}
