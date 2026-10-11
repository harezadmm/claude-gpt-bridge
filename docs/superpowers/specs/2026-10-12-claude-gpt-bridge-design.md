# claude-gpt-bridge — desain

Tanggal: 2026-10-12. Status: disetujui lisan oleh Hariz ("gas jalur A").

## Tujuan

Claude (Claude Code / Claude Desktop) bisa melempar pekerjaan ke GPT lewat satu MCP server lokal,
memakai **langganan ChatGPT Team** yang sudah login di Codex CLI, bukan API key berbayar.
Dua kebutuhan inti:

1. **Proyek ikut folder.** Saat Claude bekerja di folder A, sisi GPT otomatis punya "proyek A"
   di folder yang sama: brief, riwayat, dan hasil gambar tersimpan di `A/gpt-bridge/`.
2. **Generate gambar bolak-balik.** Claude menulis prompt → GPT (gpt-image-2 lewat tool
   `image_generation` di backend Codex) merender → PNG mendarat di folder proyek → Claude
   langsung melihat preview di hasil tool dan bisa iterasi.

Bonus murah karena transportnya sama: `ask_gpt` untuk lempar pertanyaan teks dengan konteks proyek.

## Non-goals (sengaja tidak dikerjakan sekarang)

- Arah balik (ChatGPT memanggil Claude): butuh MCP remote HTTPS + Developer mode; ditunda.
- Jalur API key resmi: disiapkan sebagai fallback via env `OPENAI_API_KEY`, tidak diaktifkan.
- Antrian job asinkron: panggilan sinkron dulu; ditambah hanya kalau timeout jadi masalah.

## Arsitektur

```
Claude ──MCP stdio──▶ claude-gpt-bridge (Node/TS)
                          │  baca/tulis  <project>/gpt-bridge/{project.json, brief.md, images/}
                          │  token dari ~/.codex/auth.json (refresh otomatis)
                          └──HTTPS SSE──▶ chatgpt.com/backend-api/codex/responses
                                              host model (gpt-5.x) ─▶ tool image_generation ─▶ gpt-image-2
```

Satu proses, tiga modul:

- `codex-auth.ts` — baca `~/.codex/auth.json`, cek `exp` JWT, refresh via `auth.openai.com/oauth/token`
  (client id publik Codex), tulis balik atomik. Pada 401: refresh sekali lalu ulang.
- `codex-client.ts` — POST Responses API dengan `stream:true`, `store:false`; parser SSE;
  `generateImage()` mengambil base64 dari item `image_generation_call`; `ask()` mengumpulkan
  `response.output_text.delta`.
- `project-store.ts` — lokasi proyek = `project_dir` param, default `process.cwd()`.
  Struktur `gpt-bridge/`:
  - `project.json`: `{ name, created, counter, settings{image_model, host_model, default_size, default_quality}, history[] }`
  - `brief.md`: teks bebas yang Claude tulis; selalu dikirim ke GPT sebagai konteks.
  - `images/NNN-slug.png`: hasil generate, nomor urut dari `counter`.
- `index.ts` — daftar tool MCP, format hasil (teks + `image` content block preview JPEG ≤512px via sharp).

## Tools

| Tool | Input | Output |
|---|---|---|
| `project_init` | `project_dir?`, `name?`, `brief?` | buat/perbarui `gpt-bridge/`, kembalikan ringkasan |
| `project_status` | `project_dir?` | brief, 10 riwayat terakhir, pengaturan, lokasi folder |
| `generate_image` | `prompt`, `project_dir?`, `size?` (1024x1024/1536x1024/1024x1536/auto), `quality?` (low/medium/high), `refs?` (≤5 path gambar), `filename?`, `use_brief?` (default true) | path PNG + preview inline + id riwayat |
| `edit_image` | sama seperti `generate_image` tapi `refs` wajib; alias semantik untuk iterasi dari gambar sebelumnya | sama |
| `ask_gpt` | `prompt`, `project_dir?`, `use_history?` (default true, 6 giliran terakhir) | teks jawaban |

Semua `project_dir` relatif diselesaikan terhadap `process.cwd()`. Folder `gpt-bridge/` dibuat
otomatis saat tool pertama dipanggil, jadi `project_init` opsional.

## Alur `generate_image`

1. Muat proyek; susun prompt akhir = brief (kalau `use_brief`) + prompt pengguna.
2. Baca refs jadi `input_image` data URL (png/jpg/webp, ≤15 MB tiap file).
3. Kirim ke Codex: `tools:[{type:"image_generation", model, size, quality}]`, `tool_choice:{type:"image_generation"}`.
4. Simpan PNG ke `images/NNN-slug.png`; tambah entri history `{id, kind:"image", prompt, file, size, quality, refs, at}`.
5. Balikkan: teks (path absolut, id, ukuran) + `image` block preview.

## Penanganan error

- Tidak ada `auth.json` / bukan `auth_mode: chatgpt` → pesan jelas: jalankan `codex login`.
- 401 setelah refresh → minta login ulang. 429 → sampaikan kuota plan habis + waktu reset kalau ada.
- Stream selesai tanpa gambar → kembalikan potongan teks terakhir dari host model (biasanya alasan penolakan).
- Timeout per panggilan 5 menit (env `GPT_BRIDGE_TIMEOUT_MS`).

## Pengujian

- Unit (node:test): parser SSE dengan fixture; project-store (counter, slug, history); auth
  (deteksi kedaluwarsa, tulis balik atomik) memakai folder sementara.
- Integrasi (manual, pakai kuota): satu `generate_image` size 1024x1024 quality low, lalu `ask_gpt`.
- Client MCP uji (`scripts/smoke.ts`): spawn server lewat `StdioClientTransport`, panggil tool.

## Instalasi

`npm run build`, lalu `claude mcp add --scope user gpt-bridge -- node C:\dev\claude-gpt-bridge\dist\index.js`.
Tool muncul di sesi Claude Code berikutnya. Konfigurasi lewat env:
`GPT_BRIDGE_HOST_MODEL` (default `gpt-5.6-luna`, fallback `gpt-5.5`), `GPT_BRIDGE_IMAGE_MODEL` (default `gpt-image-2`),
`GPT_BRIDGE_TIMEOUT_MS`, `CODEX_HOME`.

## Risiko

- Endpoint Codex bukan API publik; bisa berubah tanpa pemberitahuan. Mitigasi: fallback API key disiapkan.
- Kuota gambar berbagi dengan Codex dan ChatGPT. `project_status` menampilkan hitungan pemakaian lokal.
