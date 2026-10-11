// Unit tests for the Codex auth module. All values here are synthetic fixtures
// written into a temp directory; nothing touches the real ~/.codex.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CodexAuth, CodexAuthError, accountIdFromJwt, jwtExpiryMs } from "../codex-auth.js";

function b64url(s: string): string {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(payload))}.sig`;
}

async function fixtureHome(file: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify(file));
  return dir;
}

const NOW = 1_800_000_000_000;

test("jwt helpers decode exp and account id", () => {
  const tok = fakeJwt({ exp: 1000, "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } });
  assert.equal(jwtExpiryMs(tok), 1_000_000);
  assert.equal(accountIdFromJwt(tok), "acc-1");
  assert.equal(jwtExpiryMs("garbage"), null);
});

test("missing auth.json gives a clear login error", async () => {
  const auth = new CodexAuth({ codexHome: path.join(os.tmpdir(), "does-not-exist-" + Date.now()) });
  await assert.rejects(() => auth.getCredentials(), CodexAuthError);
});

test("fresh session is returned without refresh", async () => {
  const token = fakeJwt({ exp: (NOW + 86_400_000) / 1000, "https://api.openai.com/auth": { chatgpt_account_id: "acc-9" } });
  const home = await fixtureHome({ auth_mode: "chatgpt", tokens: { access_token: token, refresh_token: "fixture-r1" } });
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("{}");
  }) as typeof fetch;
  const auth = new CodexAuth({ codexHome: home, now: () => NOW, fetchImpl });
  const creds = await auth.getCredentials();
  assert.equal(creds.accessToken, token);
  assert.equal(creds.accountId, "acc-9");
  assert.equal(calls, 0);
});

test("stale session triggers refresh and rewrites auth.json", async () => {
  const stale = fakeJwt({ exp: (NOW + 60_000) / 1000 });
  const fresh = fakeJwt({ exp: (NOW + 864_000_000) / 1000 });
  const home = await fixtureHome({
    auth_mode: "chatgpt",
    tokens: { access_token: stale, refresh_token: "fixture-old", account_id: "acc-2" },
    last_refresh: "old",
  });
  let seenBody = "";
  let seenUrl = "";
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = String(init?.body);
    return new Response(JSON.stringify({ access_token: fresh, refresh_token: "fixture-new", id_token: "fixture-id" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const auth = new CodexAuth({ codexHome: home, now: () => NOW, fetchImpl, clientId: "app_test" });
  const creds = await auth.getCredentials();
  assert.equal(creds.accessToken, fresh);
  assert.equal(creds.accountId, "acc-2");
  assert.equal(seenUrl, "https://auth.openai.com/oauth/token");
  const params = new URLSearchParams(seenBody);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("refresh_token"), "fixture-old");
  assert.equal(params.get("client_id"), "app_test");
  const written = JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8"));
  assert.equal(written.tokens.access_token, fresh);
  assert.equal(written.tokens.refresh_token, "fixture-new");
  assert.equal(written.tokens.account_id, "acc-2");
  assert.equal(written.auth_mode, "chatgpt");
  assert.notEqual(written.last_refresh, "old");
});

test("refresh rejection surfaces as CodexAuthError", async () => {
  const stale = fakeJwt({ exp: (NOW - 1000) / 1000 });
  const home = await fixtureHome({ auth_mode: "chatgpt", tokens: { access_token: stale, refresh_token: "fixture-r" } });
  const fetchImpl = (async () => new Response("invalid_grant", { status: 400 })) as typeof fetch;
  const auth = new CodexAuth({ codexHome: home, now: () => NOW, fetchImpl });
  await assert.rejects(
    () => auth.getCredentials(),
    (e: unknown) => e instanceof CodexAuthError && /codex login/.test(e.message),
  );
});
