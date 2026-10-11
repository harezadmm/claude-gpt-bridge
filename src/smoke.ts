/**
 * Smoke client: spawns the server over stdio and calls one tool.
 *   node dist/smoke.js                       -> list tools
 *   node dist/smoke.js project_status '{}'   -> call a tool with JSON args
 * Image content blocks are written to .tmp/preview-<n>.jpg instead of printed.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "index.js");
const [toolName, jsonArgs] = process.argv.slice(2);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: process.cwd(),
  env: { ...process.env } as Record<string, string>,
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

try {
  if (!toolName) {
    const { tools } = await client.listTools();
    for (const t of tools) {
      const keys = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      console.log(`- ${t.name}: ${keys.join(", ")}`);
    }
  } else {
    const args = jsonArgs ? (JSON.parse(jsonArgs) as Record<string, unknown>) : {};
    const started = Date.now();
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: 10 * 60 * 1000 });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const content = (result.content ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    let n = 0;
    for (const c of content) {
      if (c.type === "text") console.log(c.text);
      else if (c.type === "image" && c.data) {
        n += 1;
        const out = path.resolve(".tmp", `preview-${n}.${c.mimeType === "image/png" ? "png" : "jpg"}`);
        await fs.mkdir(path.dirname(out), { recursive: true });
        await fs.writeFile(out, Buffer.from(c.data, "base64"));
        console.log(`[image ${c.mimeType} ${(c.data.length * 0.75 / 1024).toFixed(0)} KB -> ${out}]`);
      } else console.log(`[${c.type}]`);
    }
    console.log(`isError=${result.isError === true} elapsed=${secs}s`);
  }
} finally {
  await client.close();
}
