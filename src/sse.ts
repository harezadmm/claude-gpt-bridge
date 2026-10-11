/**
 * Minimal Server-Sent Events parser for fetch() bodies.
 * Yields { event, data } per message; `data` is the joined data lines.
 */
export interface SseMessage {
  event: string;
  data: string;
}

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event = "";
  let dataLines: string[] = [];

  const flush = (): SseMessage | null => {
    if (dataLines.length === 0 && event === "") return null;
    const msg = { event: event || "message", data: dataLines.join("\n") };
    event = "";
    dataLines = [];
    return msg;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const msg = flush();
          if (msg) yield msg;
          continue;
        }
        if (line.startsWith(":")) continue; // comment or keepalive
        const colon = line.indexOf(":");
        const field = colon >= 0 ? line.slice(0, colon) : line;
        let value = colon >= 0 ? line.slice(colon + 1) : "";
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") dataLines.push(value);
        // id and retry are ignored
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") {
      const line = buffer.replace(/\r$/, "");
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

/** Parse a data payload as JSON, returning null when it is not JSON (e.g. "[DONE]"). */
export function sseJson(msg: SseMessage): unknown {
  const d = msg.data.trim();
  if (d === "" || d === "[DONE]") return null;
  try {
    return JSON.parse(d);
  } catch {
    return null;
  }
}
