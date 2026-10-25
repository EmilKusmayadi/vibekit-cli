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

### Mengatur Plafon Jawaban (`gaya.maksTokenJawaban`)

`maksTokenJawaban` adalah **plafon** panjang satu respons model (dikirim sebagai `max_tokens`), bukan target: panjang jawaban sebenarnya diatur oleh `gaya.jawaban`, jadi plafon besar tidak otomatis boros. Plafon hanya berfungsi sebagai rem pengaman — tanpa batas sama sekali, tidak ada yang menghentikan model yang bertele-tele (atau menulis file tanpa henti) selain batas bawaan model itu sendiri.

| Nilai | Cocok untuk |
|---|---|
| `800` (bawaan template) | Tanya-jawab ringan, pertanyaan singkat |
| `4000` | Kerja agent dan file berukuran sedang |
| `8000`–`16000` | Membangun aplikasi, menghasilkan file besar |
| `0` (atau hapus field-nya) | **Tanpa batas** — `max_tokens` tidak dikirim sama sekali; batas bawaan model yang berlaku |

Penting untuk mode agent: isi file yang ditulis model lewat tool `tulis_file`/`edit_file` **ikut dihitung dalam plafon respons yang sama**. File yang lebih besar dari plafon akan terpotong di tengah dan gagal ditulis — bila Anda menyuruh agent membangun aplikasi atau file besar, naikkan plafonnya (atau set `0`).

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
| `vibekit ask "<pertanyaan>" [--file <path>]... [--dir <path>]... [--auto] [--tanpa-brief]` | Satu pertanyaan yang boleh berakhir dengan aksi; lampirkan file/folder sebagai konteks terseleksi. Ringkasan hemat token ditulis ke stderr, jawaban bersih di stdout, ditutup baris info model + token terpakai |
| `vibekit chat [--auto] [--lanjut] [--tanpa-brief]` | Percakapan interaktif yang juga bisa bertindak di tengah obrolan; riwayat aksi lama dipadatkan jadi ringkasan lalu dipangkas sadar-tool (maks ±4.000 token, hanya pada batas giliran utuh); `/keluar` untuk berhenti, `/auto` untuk menyala-matikan mode auto-allow, `/sesi` menampilkan id sesi aktif. Sesi tersimpan otomatis dan bisa dilanjutkan dengan `--lanjut` |
| `vibekit do "<tugas>" [--auto] [--rencana] [--tanpa-brief]` | Mode agent sekali jalan: model mengerjakan tugas nyata dengan tool file/perintah di folder saat ini (lihat bagian Mode Agent di bawah). `--rencana`: susun rencana dulu, persetujuan SATU kali, lalu eksekusi |
| `vibekit mcp` | Sambungkan semua server MCP dari konfigurasi dan daftar tool yang mereka sediakan (lihat bagian Dukungan MCP di bawah) |
| `vibekit brief` | Susun ringkasan konteks proyek ke `.vibekit/brief.md`; brief dipakai otomatis sebagai konteks pada ask/chat/do (lihat bagian Brief Proyek) |
| `vibekit hemat` | Laporan pemakaian token per penyedia (hari ini & 7 hari terakhir) + token yang terukur dihemat kompaksi riwayat |
| `vibekit sesi` | Daftar sesi chat yang tersimpan (untuk dilanjutkan dengan `chat --lanjut`) |
| `vibekit status` | Tabel per penyedia: model, status (aktif / cooldown s.d. jam / anggaran tercapai), token terpakai hari ini |
| `vibekit --help` / `--version` | Bantuan / versi |

## Mode Agent — `ask`, `chat`, dan `do`

Selain menjawab pertanyaan, VibeKit bisa **bertindak** di folder proyek Anda. Sejak v0.3.0 kemampuan agent ini menyatu ke semua perintah — pertanyaan biasa dijawab teks seperti biasa, sedangkan permintaan membuat file atau menjalankan perintah dikerjakan lewat tool dengan pagar keamanan yang sama:

- **`vibekit ask`** — satu pertanyaan yang boleh berakhir dengan aksi: `vibekit ask "buatkan file halo.txt berisi sapaan"`.
- **`vibekit chat`** — ngobrol yang bisa bertindak di tengah percakapan: minta dibuatkan file di giliran mana pun, model memakai tool lalu melanjutkan obrolan dengan riwayat yang utuh (termasuk rangkaian tool-nya).
- **`vibekit do`** — mode tugas sekali jalan: jejak langkah dicetak, ditutup ringkasan akhir, dan kode keluar mencerminkan berhasil/tidaknya tugas:

```bash
vibekit do "buatkan file halo.txt berisi sapaan, lalu tampilkan daftar file di sini"
```

Model bekerja langkah demi langkah lewat tool calling (API OpenAI-compatible yang sama, failover router yang sama), sampai ia membalas teks akhir. Ada **5 tool**:

| Tool | Fungsi | Konfirmasi? |
|---|---|---|
| `daftar_file` | Daftar isi folder | Tidak (baca-saja) |
| `baca_file` | Baca isi file teks | Tidak (baca-saja) |
| `tulis_file` | Buat/timpa file (folder induk dibuat bila perlu) | **Ya, satu per satu** |
| `edit_file` | Ganti kemunculan pertama `teksLama` → `teksBaru` dalam file | **Ya, satu per satu** |
| `jalankan_perintah` | Jalankan perintah shell (timeout 60 detik, keluaran ditangkap) | **Ya, satu per satu** |

**Model keamanan:**

- **Hanya folder kerja (cwd).** Semua path di-resolve terhadap folder tempat perintah dijalankan; path yang keluar dari folder itu (mis. `../`) ditolak eksekutor, bahkan bila pengguna menyetujui.
- **Konfirmasi per aksi.** Setiap aksi yang mengubah file atau menjalankan perintah menampilkan deskripsi aksinya (path + pratinjau konten untuk tulis, potongan teks lama→baru untuk edit, perintah lengkap untuk shell) dan hanya berjalan bila Anda menjawab `y`/`ya` — selain itu dianggap menolak, dan penolakan itu dilaporkan ke model agar ia menyesuaikan rencana.
- **Mode auto-allow (opsional, sejak v0.4.0).** Flag `--auto` (alias `--yes`) pada `ask`, `chat`, dan `do` — atau perintah `/auto` di tengah sesi chat — melewati konfirmasi per aksi: semua aksi tulis/perintah langsung dijalankan. Pagar folder kerja TIDAK ikut dilepas (path traversal tetap ditolak), tetapi risikonya nyata: model bisa menulis atau menjalankan sesuatu tanpa sempat Anda periksa. Hanya aktifkan di folder yang aman (folder uji, proyek sekali pakai) dan untuk tugas yang Anda percayai.
- **Batas 12 langkah** per giliran/tugas, dan hasil tiap tool dipangkas (±4.000 karakter) sebelum dikirim balik ke model demi hemat token.
- **Riwayat chat yang aman untuk tool.** Pemangkasan riwayat chat hanya terjadi pada batas giliran utuh (satu pesan pengguna + seluruh rangkaian tool-nya), sehingga tidak pernah ada pesan hasil tool yang yatim atau panggilan tool yang kehilangan hasilnya.

## Dukungan MCP (Model Context Protocol)

Sejak v0.5.0, agent VibeKit bisa memakai **tool dari server MCP mana pun**. VibeKit berperan sebagai MCP *client*: daftarkan server lewat field `mcpServers` di konfigurasi, dan tool mereka tampil **berdampingan dengan 5 tool bawaan** pada `ask`, `chat`, dan `do`. Nama tool ter-namespace menjadi `mcp__<namaServer>__<namaTool>` agar tidak bertabrakan antar server maupun dengan tool bawaan.

Ada dua transport:

- **stdio** — server lokal dijalankan sebagai proses anak lewat `perintah` + `argumen` (pesan JSON-RPC per baris/NDJSON). Cocok untuk server MCP komunitas yang umumnya didistribusikan sebagai perintah `npx`/`node`/`python`.
- **HTTP (Streamable HTTP)** — server remote dipanggil lewat POST JSON-RPC ke `url`; header tambahan (mis. API key) diatur lewat `headers`. Jawaban JSON biasa maupun aliran SSE sama-sama didukung, dan `Mcp-Session-Id` dari server diteruskan antar-request.

### Contoh: server lokal (stdio)

```json
{
  "mcpServers": [
    {
      "nama": "filesystem",
      "perintah": "npx",
      "argumen": ["-y", "@modelcontextprotocol/server-filesystem", "D:/proyek-saya"]
    }
  ]
}
```

### Contoh: server remote (HTTP) — Google Stitch

Stitch (alat desain UI Google) menyediakan server MCP remote. Contoh konfigurasinya:

```json
{
  "mcpServers": [
    {
      "nama": "stitch",
      "url": "https://stitch.googleapis.com/mcp",
      "headers": { "X-Goog-Api-Key": "ISI_API_KEY_STITCH_MU" }
    }
  ]
}
```

> **Catatan tegas:** contoh di atas hanya pola konfigurasinya. Anda memerlukan **akses dan API key Stitch milik Anda sendiri** — nilai `ISI_API_KEY_STITCH_MU` adalah placeholder yang harus diganti key Anda (atau simpan key di tempat aman dan jangan commit file konfigurasi yang sudah terisi). Hal yang sama berlaku untuk server remote lain: header autentikasi selalu kredensial Anda sendiri.

### Melihat tool yang tersedia

```bash
vibekit mcp
```

Perintah ini menyambungkan semua server di `mcpServers`, mencetak daftar tool per server beserta deskripsi singkatnya, lalu memutuskan sambungan. Saat `ask`/`chat`/`do` berjalan, satu baris `MCP <nama>: N tool` dicetak per server yang berhasil tersambung; server yang gagal cukup dicatat sebagai peringatan — server lain tetap jalan.

### Keamanan tool MCP

Tool MCP adalah **aksi pihak ketiga** yang dijalankan atas nama Anda, jadi perlakuannya sama dengan tool mutasi bawaan: **selalu meminta konfirmasi Anda satu per satu** (pratinjau menampilkan nama tool + argumennya), dan penolakan dilaporkan ke model. Mode auto-allow (`--auto`/`--yes`/`/auto`) melewati konfirmasi itu juga untuk tool MCP — aktifkan hanya bila Anda mempercayai server MCP yang terdaftar dan tugasnya. Sambungkan hanya server MCP yang Anda kenal sumbernya.

## Laporan Pemakaian — `vibekit hemat`

Menampilkan pemakaian token per penyedia untuk **hari ini** dan **7 hari terakhir**, ditambah token yang **terukur** dibuang oleh kompaksi riwayat chat (hari ini + total tercatat):

```bash
vibekit hemat
```

Soal kejujuran angka: hanya penghematan kompaksi yang diangkakan, karena memang bisa dihitung persis dari konten yang dibuang. Penghematan dari gaya jawaban ringkas dan konteks terseleksi bersifat *desain* (mencegah token terpakai sejak awal) dan dinyatakan sebagai catatan, bukan angka karangan.

## Streaming Jawaban

Jawaban pada `ask` dan `chat`, serta ringkasan akhir `do`, **dialirkan (streaming)**: teks tampil potongan demi potongan begitu model menulisnya, bukan menunggu selesai semua. Aturan failover-nya:

- Error HTTP **sebelum token pertama** (429 kuota, 503, dll.) diperlakukan persis seperti mode biasa: retry/cooldown/failover ke penyedia berikutnya.
- Error **di tengah aliran, setelah sebagian jawaban tampil**, TIDAK di-failover — mengulang ke penyedia lain akan menggandakan keluaran. Giliran dinyatakan gagal dengan pesan khusus, dan di chat giliran itu digulung balik seperti kegagalan lain.
- Pemakaian token tetap tercatat: dari `usage` di akhir aliran bila penyedia mengirimnya, atau estimasi tokenizer lokal atas teks yang terakumulasi.

## Mode Rencana — `vibekit do "<tugas>" --rencana`

Untuk tugas besar yang ingin Anda periksa dulu arahnya:

```bash
vibekit do "rapikan struktur folder src dan perbarui README" --rencana
```

Alurnya: (1) model menyusun **rencana langkah bernomor** (satu panggilan tanpa tool); (2) rencana dicetak dan Anda ditanya **satu kali**: `Jalankan rencana ini? (y/N)`; (3) ditolak → tidak ada satu pun tool yang berjalan, perintah selesai normal; (4) disetujui → rencana disuntikkan ke konteks tugas dan eksekusi berjalan **tanpa konfirmasi per langkah** (persetujuan rencana = persetujuan eksekusi). Pagar folder kerja dan batas 12 langkah tetap berlaku penuh.

## Sesi Chat Tersimpan — `chat --lanjut` & `vibekit sesi`

Setiap sesi `vibekit chat` **tersimpan otomatis** (di `~/.vibekit/sesi/`) setelah setiap giliran yang berhasil — riwayat internal disimpan apa adanya, termasuk pesan mentah tool, jadi sesi yang dilanjutkan tetap sah untuk model seperti Gemini 3.

```bash
vibekit sesi            # daftar sesi: id, waktu, jumlah pesan, cuplikan
vibekit chat --lanjut   # lanjutkan sesi terakhir persis dari tempat berhenti
```

Di tengah sesi, perintah `/sesi` menampilkan id sesi aktif. Tanpa `--lanjut`, `vibekit chat` selalu memulai sesi baru seperti biasa. Kompaksi dan pemangkasan aman tetap diterapkan per giliran pada sesi lanjutan.

## Brief Proyek — `vibekit brief`

Memindai folder kerja (pohon maks 3 tingkat, melewati `node_modules`/`.git`/`dist`/`build`/file biner) dan menyusun ringkasan konteks yang padat ke **`.vibekit/brief.md`**: nama proyek, bahasa dominan, stack & dependencies dari `package.json`, scripts, file konfigurasi penting yang terdeteksi (hanya nama — isi `.env` asli tidak pernah dibaca), ekstensi terbanyak, struktur folder, dan potongan awal README.

```bash
cd proyek-saya && vibekit brief
```

Setelah brief ada, `ask`/`chat`/`do` **memakai brief itu otomatis** sebagai konteks tambahan (dicetak satu baris `(memakai brief proyek: ±N token)`; brief di atas 4.000 token dipotong dengan penanda). Lewatkan per perintah dengan flag `--tanpa-brief`. Jalankan ulang `vibekit brief` bila struktur proyek berubah banyak.

## Cara Failover Bekerja

1. Sebelum memanggil, router memeriksa state lokal (`~/.vibekit/state.json`): penyedia yang masih **cooldown** atau sudah mencapai **anggaran harian** dilewati tanpa dipanggil.
2. Saat memanggil, permintaan berisi system prompt hemat sesuai `gaya.jawaban` dan `max_tokens` = `gaya.maksTokenJawaban` (hanya bila diatur > 0; nilai `0` atau field yang dihapus berarti `max_tokens` tidak dikirim sama sekali — tanpa batas). Objek `extraBody` per penyedia (bila ada) digabung ke body — berguna untuk kenop khas model, mis. menekan penalaran.
3. Bila respons menandakan kuota habis — HTTP **429/402** atau pola error `insufficient_quota` / `RESOURCE_EXHAUSTED` / saldo — penyedia ditandai **cooldown sampai akhir hari lokal** dan permintaan yang sama diulangi ke penyedia berikutnya. Rate-limit singkat (429 tanpa pola kuota) → cooldown `jedaCooldownMenit` (bawaan 15 menit). Khusus HTTP 503 (server penyedia sedang sibuk/penuh sesaat), penyedia yang sama dicoba ulang dulu sampai 2 kali dengan jeda 3 dan 8 detik, dan 503 tidak memicu cooldown.
4. Error lain (401 kunci salah, 400, jaringan) **tidak** dianggap kuota habis: dicatat apa adanya dan router tetap mencoba penyedia berikutnya.
5. Token terpakai dicatat dari field `usage` respons (atau estimasi tokenizer bila tidak ada). Bila semua penyedia gagal/habis, Anda menerima ringkasan status tiap penyedia dan jam paling awal untuk mencoba lagi.

## Penghematan Token

- **System prompt ringkas** — gaya `poin-penting` memerintahkan model menjawab hanya poin penting tanpa basa-basi; tersedia juga `normal` dan `detail`.
- **Plafon jawaban** — `maksTokenJawaban` menjadi `max_tokens` di setiap permintaan bila diatur > 0; `0` (atau field dihapus) berarti tanpa batas. Ini plafon, bukan target — lihat tabel anjuran di bagian Mulai Cepat.
- **Konteks terseleksi** — `--file/--dir` melewati file biner & file > 256 KB, memangkas baris komentar penuh dan baris kosong berlebih, dan membatasi total konteks (±16.000 token) dengan memotong berkas terbesar. Selisih token mentah vs terseleksi selalu ditampilkan.
- **Kompaksi riwayat aksi (chat)** — rangkaian tool giliran-giliran lama dipadatkan menjadi ringkasan satu baris (`[Aksi selesai: tulis_file index.html — OK]`) sebelum giliran baru dimulai, jadi isi file yang pernah ditulis/dibaca model tidak dikirim ulang ke API di setiap giliran. Giliran terakhir tidak pernah disentuh kompaksi, sehingga `thought_signature` Gemini tetap utuh selama dibutuhkan. Token yang dibuang kompaksi **diukur dan dicatat** — lihat laporannya di `vibekit hemat`.
- **Brief proyek** — `.vibekit/brief.md` memberi model konteks proyek yang padat dan stabil, jauh lebih murah daripada melampirkan banyak file mentah berulang kali.
- **Anggaran & pencatatan** — pemakaian per penyedia per hari terlihat di `vibekit status` dan laporan lengkapnya di `vibekit hemat`, sehingga boros selalu kelihatan.

## Referensi Konfigurasi — Nilai yang Didukung

Ringkasan semua field konfigurasi beserta nilai sahnya, supaya tidak perlu menebak.

### `gaya.jawaban`

Mengatur gaya system prompt hemat yang dikirim pada setiap permintaan. Tepat **tiga nilai** yang dikenal:

| Nilai | Perilaku |
|---|---|
| `poin-penting` | **(bawaan)** Jawaban wajib hanya poin-poin penting dalam format poin; kalimat pembuka/penutup, sapaan, dan basa-basi dilarang keras; kode diberikan sebagai blok kode dengan penjelasan pendamping maksimal satu baris. Paling hemat token. |
| `normal` | Ringkas dan langsung ke inti, tetapi kalimat biasa yang mengalir — tidak dipaksa bentuk poin, tidak sekaku `poin-penting`. |
| `detail` | Jawaban jelas dan terstruktur; boleh panjang bila memang perlu, dengan subjudul atau poin agar mudah dibaca. Paling longgar (dan paling boros token) di antara ketiganya. |

Nilai lain, nilai kosong, atau field yang tidak diisi **dianggap `poin-penting`**.

### `gaya.maksTokenJawaban`

Plafon token untuk **satu respons** model (dikirim sebagai `max_tokens`) — plafon, bukan target:

| Nilai | Arti |
|---|---|
| Angka bulat `> 0` (mis. `800`, `4000`, `16000`) | Plafon sebesar itu; respons yang melewatinya dipotong. Lihat tabel anjuran pemakaian di bagian Mengatur Plafon Jawaban. |
| `0`, atau field dihapus / tidak diisi | **Tanpa batas** — `max_tokens` tidak dikirim sama sekali; batas bawaan model yang berlaku. |
| Bawaan template `init` | `800`. |

### Field lain, sekilas

| Field | Nilai / arti |
|---|---|
| `providers` | Array penyedia; **urutan = prioritas** — entri pertama adalah bawaan, berikutnya cadangan failover. |
| `providers[].jedaCooldownMenit` | Menit istirahat sebuah penyedia setelah kena rate-limit singkat (HTTP 429 tanpa pola kuota). Bawaan `15`. Kuota yang benar-benar habis selalu cooldown sampai akhir hari lokal, berapa pun nilai field ini. |
| `providers[].anggaranHarian` | **Opsional.** Batas token per hari yang dicatat lokal; penyedia yang mencapai batas dilewati sebelum dipanggil. Tidak diisi = tanpa anggaran lokal (hanya kuota asli penyedia yang berlaku). |
| `providers[].apiKey` | Kunci API langsung, atau `env:NAMA_VAR` untuk membaca dari variabel lingkungan. |
| `providers[].extraBody` | **Opsional.** Objek bebas yang digabung apa adanya ke body permintaan (kenop khas model/penyedia). |
| `mcpServers` | **Opsional.** Daftar server MCP (lihat bagian Dukungan MCP): tiap entri wajib punya `nama` plus `perintah` (stdio lokal, dengan `argumen`/`env` opsional) atau `url` (HTTP remote, dengan `headers` opsional). |

## Pemecahan Masalah

### Windows PowerShell: `vibekit : The term 'vibekit' is not recognized as the name of a cmdlet...`

Setelah `npm install -g @chispear/vibekit` berhasil, menjalankan `vibekit init` (atau perintah `vibekit` lain) di PowerShell bisa gagal dengan error `CommandNotFoundException`:

```
vibekit : The term 'vibekit' is not recognized as the name of a cmdlet, function, script file, or operable program.
```

**Penyebab:** folder tempat npm menyimpan perintah global — hasil `npm config get prefix`, umumnya `C:\Users\<nama>\AppData\Roaming\npm` — belum ada di PATH Windows, jadi PowerShell tidak menemukan perintahnya. Package-nya sendiri sebenarnya sudah terpasang dengan benar; ini murni soal PATH.

**Perbaikan cepat** (hanya untuk jendela PowerShell yang sedang terbuka):

```powershell
$env:Path += ";" + (npm config get prefix)
```

**Perbaikan permanen** (sekali saja, lalu tutup dan buka lagi PowerShell):

```powershell
$prefix = npm config get prefix
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", "$userPath;$prefix", "User")
```

**Verifikasi:** `vibekit --version` harus menampilkan nomor versi (mis. `0.4.1`).

**Alternatif tanpa mengubah PATH:** jalankan lewat npx — `npx @chispear/vibekit <perintah>` (mis. `npx @chispear/vibekit init`).

## Pengembangan

```bash
npm install
npm test        # build + uji node:test melawan server tiruan lokal (tanpa API key asli)
npm run build   # tsc → dist/
```

Keputusan repo: `dist/` masuk `.gitignore` dan dibangun saat publish (`prepublishOnly`), jadi repo tetap bersih; `vibekit.config.json` dan `.vibekit/` juga di-ignore karena dapat berisi API key.

## Status Nama di npm

Package ini terbit di npm sebagai **`@chispear/vibekit`** (v0.1.0, 25 Oktober 2026; v0.2.0 menambahkan mode agent `vibekit do`; v0.3.0 menggabungkan kemampuan agent itu ke `ask` dan `chat`; v0.4.0 menambahkan mode auto-allow dan kompaksi riwayat aksi; v0.5.0 menambahkan dukungan MCP; v0.6.0 menambahkan laporan `hemat`, streaming jawaban, mode `--rencana`, sesi chat yang bisa dilanjutkan, dan brief proyek) karena nama tak-scoped `vibekit` sudah dipakai proyek lain. Nama perintah CLI tetap `vibekit`.

## Lisensi

MIT
