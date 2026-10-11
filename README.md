# claude-gpt-bridge

MCP server yang menghubungkan Claude ke GPT lewat **langganan ChatGPT** yang sudah login di Codex CLI.
Tanpa API key, tanpa biaya per gambar. Semua state proyek ikut folder yang sedang dikerjakan Claude.

```
Claude ──MCP stdio──▶ claude-gpt-bridge ──HTTPS SSE──▶ backend Codex (chatgpt.com)
                          │                                 host model ─▶ image_generation ─▶ gpt-image-2
                          └── <project>/gpt-bridge/{project.json, brief.md, images/}
```

## Prasyarat

- Node.js 20+
- Codex CLI login dengan akun ChatGPT (`codex login status` → "Logged in using ChatGPT")
- `codex features list | findstr image_generation` → `stable true`

## Instalasi

```bash
cd C:\dev\claude-gpt-bridge
npm install
npm run build
claude mcp add --scope user gpt-bridge -- node C:\dev\claude-gpt-bridge\dist\index.js
```

Tool muncul di sesi Claude Code berikutnya (restart sesi). Untuk Claude Desktop, tambahkan entri yang sama di `claude_desktop_config.json`.

## Tools

| Tool | Fungsi |
|---|---|
| `project_init` | Buat/perbarui proyek GPT di folder: `gpt-bridge/project.json` + `brief.md` (gaya, palet, subjek, batasan). Brief selalu ikut dikirim ke GPT. |
| `project_status` | Lihat brief, pengaturan model, 10 riwayat terakhir, status login Codex. |
| `generate_image` | Prompt → gpt-image-2 → PNG di `gpt-bridge/images/NNN-slug.png` + preview inline supaya Claude bisa menilai hasil. Opsional `refs` (≤5 gambar) untuk bawa karakter/gaya/logo. |
| `edit_image` | Sama, tapi `refs` wajib: iterasi dari gambar sebelumnya ("sama tapi palet biru"). |
| `ask_gpt` | Pertanyaan teks ke GPT dengan brief + 6 percakapan terakhir sebagai konteks. |

Semua tool menerima `project_dir` (path absolut folder proyek). Kalau kosong, memakai working directory server.

## Konfigurasi (env)

| Env | Default | Keterangan |
|---|---|---|
| `GPT_BRIDGE_HOST_MODEL` | `gpt-5.6-luna` | Model host yang memanggil tool gambar. Kalau ditolak (400), otomatis coba `gpt-5.5`. |
| `GPT_BRIDGE_IMAGE_MODEL` | `gpt-image-2` | Model gambar. |
| `GPT_BRIDGE_DEFAULT_SIZE` / `GPT_BRIDGE_DEFAULT_QUALITY` | `1024x1024` / `medium` | Default per proyek baru. |
| `GPT_BRIDGE_TIMEOUT_MS` | `300000` | Batas waktu satu panggilan. |
| `GPT_BRIDGE_REASONING_EFFORT` | (kosong) | `low`/`medium`/`high` untuk `ask_gpt`. |
| `CODEX_HOME` | `~/.codex` | Lokasi `auth.json`. |
| `GPT_BRIDGE_OAUTH_CLIENT_ID` | client id publik Codex | Dipakai saat refresh token. |

Per proyek, `host_model` dan `image_model` bisa dioverride lewat `project_init`.

## Smoke test

```bash
node dist/smoke.js                                   # daftar tool
node dist/smoke.js project_status '{"project_dir":"C:/path/proyek"}'
node dist/smoke.js generate_image '{"project_dir":"C:/path/proyek","prompt":"...","quality":"low"}'
```

Preview gambar dari hasil tool ditulis ke `.tmp/preview-N.jpg`.

## Catatan

- Endpoint backend Codex bukan API publik; bisa berubah tanpa pemberitahuan. Kalau putus, cek dulu `codex login status` lalu versi Codex CLI.
- Kuota gambar berbagi dengan Codex dan ChatGPT. Status 429 = kuota habis.
- Token di `~/.codex/auth.json` di-refresh otomatis saat hampir kedaluwarsa (lifetime ±10 hari), ditulis balik dengan cara yang sama seperti Codex.
- stdout adalah kanal MCP; log server keluar di stderr dengan prefix `[gpt-bridge]`.
