import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ProjectStore, resolveProjectDir, slugify } from "../project-store.js";

const DEFAULTS = { image_model: "img", host_model: "host", default_size: "1024x1024", default_quality: "medium" };

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "gpt-bridge-"));
}

test("slugify keeps it short and safe", () => {
  assert.equal(slugify("A Blue 3D Icon of a Rocket!!"), "a-blue-3d-icon-of-a-rocket");
  assert.equal(slugify("   "), "image");
  assert.equal(slugify("x".repeat(100)).length, 40);
});

test("resolveProjectDir defaults to cwd and resolves relative paths", () => {
  assert.equal(resolveProjectDir(undefined, "C:\\base"), path.resolve("C:\\base"));
  assert.equal(resolveProjectDir("sub", "C:\\base"), path.resolve("C:\\base", "sub"));
});

test("load creates gpt-bridge folder and project.json", async () => {
  const root = await tmpRoot();
  const store = new ProjectStore(root, DEFAULTS);
  assert.equal(await store.exists(), false);
  const data = await store.load();
  assert.equal(data.name, path.basename(root));
  assert.equal(data.counter, 0);
  assert.deepEqual(data.settings, DEFAULTS);
  assert.equal(await store.exists(), true);
  await fs.access(store.imagesDir);
});

test("nextImagePath increments and persists the counter", async () => {
  const root = await tmpRoot();
  const store = new ProjectStore(root, DEFAULTS);
  const data = await store.load();
  const a = await store.nextImagePath(data, "Red Fox Icon");
  const b = await store.nextImagePath(data, "Red Fox Icon", "png", "custom-name.png");
  assert.equal(a.id, 1);
  assert.equal(a.rel, "gpt-bridge/images/001-red-fox-icon.png");
  assert.equal(b.id, 2);
  assert.equal(path.basename(b.abs), "custom-name.png");
  const reloaded = await new ProjectStore(root, DEFAULTS).load();
  assert.equal(reloaded.counter, 2);
});

test("brief round-trips and history is capped", async () => {
  const root = await tmpRoot();
  const store = new ProjectStore(root, DEFAULTS);
  const data = await store.load();
  assert.equal(await store.readBrief(), null);
  await store.writeBrief("# Brief\nblue palette");
  assert.equal(await store.readBrief(), "# Brief\nblue palette\n");
  for (let i = 0; i < 205; i++) {
    store.appendHistory(data, { kind: "ask", prompt: `q${i}`, answer: `a${i}` });
  }
  assert.equal(data.history.length, 200);
  assert.equal(data.history[0]!.prompt, "q5");
  assert.equal(store.recentAsks(data, 2).map((h) => h.prompt).join(","), "q203,q204");
});
