# VibeKit CLI

**Router AI hemat token untuk terminal Anda.** Daftarkan banyak penyedia model AI (GPT/OpenAI, Gemini, DeepSeek, OpenRouter, bahkan model lokal Ollama) dalam satu file konfigurasi — VibeKit memakai penyedia pertama sebagai bawaan, dan **otomatis pindah ke penyedia berikutnya bila kuota terdeteksi habis**. Setiap jawaban diatur ringkas poin-poin penting dan dibatasi tokennya, konteks dipilih & dipangkas sebelum dikirim, dan pemakaian token dicatat per hari per penyedia.

> **Token-savvy AI router for your terminal.** Register multiple AI providers in one config file — VibeKit uses the first as default and **fails over automatically when a quota runs out**, keeps answers brief and to the point, trims attached context, and tracks daily per-provider token usage.

## Kenapa VibeKit?

- **Failover otomatis** — kuota GPT habis di tengah hari? Permintaan yang sama diulang transparan ke Gemini, lalu DeepSeek. Anda tidak perlu ganti alat atau ganti konfigurasi.
- **Irit token by design** — system prompt "poin-penting", batas `max_tokens`, lampiran konteks yang diseleksi (file biner & raksasa dilewati, komentar dipangkas, ada laporan hemat token), dan riwayat chat yang dipangkas otomatis.
- **Anggaran harian per penyedia** — pasang batas token harian; penyedia yang mencapai batas dilewati *sebelum* menabrak kuota beneran.
- **Satu format untuk semua** — semua penyedia dipanggil lewat API OpenAI-compatible (`/chat/completions`). Penyedia apa pun yang kompatibel bisa ditambahkan hanya lewat konfigurasi.
- **Lokal & privat** — API key tersimpan di komputer Anda (`~/.vibekit/config.json`), tidak ada server perantara.

## Instalasi

```bash
npm install -g @chispear/vibekit      # npm
pnpm add -g @chispear/vibekit         # pnpm
npx @chispear/vibekit ask "halo"      # tanpa install, langsung coba
```

Setelah install global, perintahnya tetap `vibekit` (nama package-nya saja yang scoped).

Butuh Node.js >= 18.

## Mulai Cepat

```bash
vibekit init
```

Perintah ini membuat `~/.vibekit/config.json`:

```json
{
  "providers": [
    { "nama": "gpt",      "baseUrl": "https://api.openai.com/v1",                              "apiKey": "", "model": "gpt-4o-mini",     "anggaranHarian": 500000, "jedaCooldownMenit": 15 },
    { "nama": "gemini",   "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai/", "apiKey": "", "model": "gemini-3.8-flash", "jedaCooldownMenit": 15 },
    { "nama": "deepseek", "baseUrl": "https://api.deepseek.com/v1",                            "apiKey": "", "model": "deepseek-chat",    "jedaCooldownMenit": 15 }
  ],
  "gaya": { "jawaban": "poin-penting", "maksTokenJawaban": 800 }
}
```

Isi `apiKey` tiap penyedia (atau gunakan sintaks `"env:NAMA_VAR"` untuk membaca dari variabel lingkungan). **Urutan array = prioritas**: `gpt` dipakai duluan; bila kuotanya habis, lanjut `gemini`, lalu `deepseek`. Tambah penyedia lain (OpenRouter, Ollama lokal) cukup dengan menambah entri — lihat `examples/vibekit.config.json`.

Konfigurasi per proyek: file `./vibekit.config.json` di folder proyek **menimpa** konfigurasi global, jadi tiap proyek bisa punya susunan penyedia sendiri.

Lalu:

```bash
vibekit ask "jelaskan apa itu REST API"
vibekit ask "tinjau kode ini" --file src/app.ts --dir src/
vibekit chat
vibekit status
```

## Perintah

| Perintah | Fungsi |
|---|---|
| `vibekit init` | Buat `~/.vibekit/config.json` dari template (tidak menimpa yang sudah ada) |
| `vibekit ask "<pertanyaan>" [--file <path>]... [--dir <path>]...` | Tanya sekali; lampirkan file/folder sebagai konteks terseleksi. Ringkasan hemat token ditulis ke stderr, jawaban bersih di stdout, ditutup baris info model + token terpakai |
| `vibekit chat` | Percakapan interaktif; riwayat dipangkas otomatis (maks ±4.000 token, giliran tertua dibuang); `/keluar` untuk berhenti |
| `vibekit status` | Tabel per penyedia: model, status (aktif / cooldown s.d. jam / anggaran tercapai), token terpakai hari ini |
| `vibekit --help` / `--version` | Bantuan / versi |

## Cara Failover Bekerja

1. Sebelum memanggil, router memeriksa state lokal (`~/.vibekit/state.json`): penyedia yang masih **cooldown** atau sudah mencapai **anggaran harian** dilewati tanpa dipanggil.
2. Saat memanggil, permintaan berisi system prompt hemat sesuai `gaya.jawaban` dan `max_tokens` = `gaya.maksTokenJawaban`. Objek `extraBody` per penyedia (bila ada) digabung ke body — berguna untuk kenop khas model, mis. menekan penalaran.
3. Bila respons menandakan kuota habis — HTTP **429/402** atau pola error `insufficient_quota` / `RESOURCE_EXHAUSTED` / saldo — penyedia ditandai **cooldown sampai akhir hari lokal** dan permintaan yang sama diulangi ke penyedia berikutnya. Rate-limit singkat (429 tanpa pola kuota) → cooldown `jedaCooldownMenit` (bawaan 15 menit).
4. Error lain (401 kunci salah, 400, jaringan) **tidak** dianggap kuota habis: dicatat apa adanya dan router tetap mencoba penyedia berikutnya.
5. Token terpakai dicatat dari field `usage` respons (atau estimasi tokenizer bila tidak ada). Bila semua penyedia gagal/habis, Anda menerima ringkasan status tiap penyedia dan jam paling awal untuk mencoba lagi.

## Penghematan Token

- **System prompt ringkas** — gaya `poin-penting` memerintahkan model menjawab hanya poin penting tanpa basa-basi; tersedia juga `normal` dan `detail`.
- **Batas jawaban keras** — `maksTokenJawaban` menjadi `max_tokens` di setiap permintaan.
- **Konteks terseleksi** — `--file/--dir` melewati file biner & file > 256 KB, memangkas baris komentar penuh dan baris kosong berlebih, dan membatasi total konteks (±16.000 token) dengan memotong berkas terbesar. Selisih token mentah vs terseleksi selalu ditampilkan.
- **Anggaran & pencatatan** — pemakaian per penyedia per hari terlihat di `vibekit status`, sehingga boros selalu kelihatan.

## Pengembangan

```bash
npm install
npm test        # build + uji node:test melawan server tiruan lokal (tanpa API key asli)
npm run build   # tsc → dist/
```

Keputusan repo: `dist/` masuk `.gitignore` dan dibangun saat publish (`prepublishOnly`), jadi repo tetap bersih; `vibekit.config.json` dan `.vibekit/` juga di-ignore karena dapat berisi API key.

## Status Nama di npm

Package ini terbit di npm sebagai **`@chispear/vibekit`** (v0.1.0, 25 Oktober 2026) karena nama tak-scoped `vibekit` sudah dipakai proyek lain. Nama perintah CLI tetap `vibekit`.

## Lisensi

MIT
