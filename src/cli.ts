#!/usr/bin/env node
import readline from "node:readline";
import {
  buatConfigGlobal,
  configDir,
  globalConfigPath,
  muatConfig,
  simpanTokenLayani,
  statePath,
} from "./config.js";
import { buatTokenLayani, mulaiServerLayani } from "./layani.js";
import {
  jalankanAgent,
  jalankanAgentRencana,
  jalankanGiliran,
  kompaksiRiwayatAksiTerukur,
  pangkasRiwayatAman,
  SYSTEM_PROMPT_GABUNGAN,
  type Konfirmasi,
} from "./agent.js";
import { teksBanner } from "./banner.js";
import { AWALAN_KONTEKS_BRIEF, buatBrief, muatKonteksBrief } from "./brief.js";
import { bangunKonteks } from "./context.js";
import { sambungkanMcpServers } from "./mcp.js";
import {
  buatIdSesi,
  daftarSesi,
  folderSesi,
  muatSesiTerakhir,
  simpanSesi,
  type SesiChat,
} from "./sesi.js";
import {
  bangunLaporanHemat,
  catatHematKompaksi,
  formatJam,
  muatState,
  sedangCooldown,
  statePenyedia,
} from "./state.js";
import { formatAngka } from "./token.js";
import type { ChatMessage, ProviderConfig, ToolDefinition, VibekitConfig } from "./types.js";

const VERSI = "0.7.0";
const BATAS_TOKEN_RIWAYAT = 4000;

function bantuan(): void {
  console.log(`VibeKit CLI v${VERSI} — router AI hemat token dengan failover otomatis

Penggunaan:
  vibekit init                          Buat ~/.vibekit/config.json dari template
  vibekit ask "<pertanyaan>" [opsi]     Tanya sekali (bisa bertindak: membuat file & menjalankan perintah dengan persetujuanmu)
  vibekit chat [opsi]                   Percakapan interaktif yang juga bisa bertindak (perintah /keluar untuk berhenti)
  vibekit do "<tugas>" [opsi]           Mode agent sekali jalan: kerjakan tugas dengan tool file/perintah di folder ini
  vibekit mcp                           Daftar tool dari server MCP pada konfigurasi (field mcpServers)
  vibekit layani [opsi]                 Layani folder ini ke agen AI eksternal lewat server MCP (token + konfirmasi terminal)
  vibekit brief                         Susun ringkasan konteks proyek ke .vibekit/brief.md (dipakai otomatis sebagai konteks)
  vibekit hemat                         Laporan pemakaian token (hari ini & 7 hari) + token yang dihemat kompaksi riwayat
  vibekit sesi                          Daftar sesi chat tersimpan (bisa dilanjutkan dengan chat --lanjut)
  vibekit status                        Status & pemakaian token tiap penyedia hari ini
  vibekit --help                        Tampilkan bantuan ini
  vibekit --version                     Tampilkan versi

Opsi ask:
  --file <path>    Lampirkan file sebagai konteks (boleh diulang)
  --dir <path>     Lampirkan isi folder sebagai konteks (boleh diulang)
  --auto, --yes    Mode auto-allow: aksi tulis/perintah langsung dijalankan
                   tanpa persetujuan (tetap terkunci di folder kerja)
  --tanpa-brief   Lewatkan brief proyek (.vibekit/brief.md) untuk pertanyaan ini

Opsi chat:
  --lanjut         Lanjutkan sesi chat terakhir yang tersimpan (riwayat dipulihkan)
  --auto, --yes    Mode auto-allow seperti di atas; di tengah sesi, perintah
                   /auto menyalakan/mematikannya kapan saja, /sesi menampilkan
                   id sesi aktif, /keluar untuk berhenti
  --tanpa-brief   Lewatkan brief proyek untuk sesi ini

Opsi do:
  --auto, --yes    Mode auto-allow seperti di atas
  --rencana        Susun rencana langkah dulu, minta persetujuanmu SATU kali,
                   lalu jalankan rencana itu tanpa konfirmasi per langkah
  --tanpa-brief   Lewatkan brief proyek untuk tugas ini

Streaming:
  Jawaban ask/chat dan ringkasan akhir do tampil mengalir (streaming) begitu
  model menulisnya. Bila aliran terputus di TENGAH jalan setelah sebagian
  jawaban tampil, permintaan tidak diulang ke penyedia lain agar keluaran
  tidak ganda; error sebelum token pertama tetap di-failover seperti biasa.

Kemampuan agent (ask, chat, do):
  Sejak v0.3.0 ketiga perintah itu bisa bertindak, bukan hanya menjawab:
  bila kamu meminta dibuatkan/diubah file atau menjalankan perintah, model
  memakai tool di folder tempat perintah dijalankan. Tool baca (daftar_file,
  baca_file) berjalan langsung; tool yang mengubah sesuatu (tulis_file,
  edit_file, jalankan_perintah) selalu meminta persetujuanmu satu per satu
  — jawaban selain y/ya berarti ditolak. Batas 12 langkah per giliran.
  Mode auto-allow (--auto/--yes, atau /auto di chat) melewati persetujuan
  itu: semua aksi langsung dijalankan, pagar folder kerja tetap berlaku.
  Hanya aktifkan di folder yang aman dan untuk tugas yang kamu percayai.
  Perbedaannya: ask = satu pertanyaan yang boleh berakhir dengan aksi,
  chat = percakapan yang bisa bertindak di tengah obrolan,
  do = mode tugas sekali jalan dengan jejak langkah & ringkasan akhir.
  Contoh: vibekit do "buatkan file halo.txt berisi sapaan, lalu tampilkan daftar file di sini"

Dukungan MCP (Model Context Protocol):
  Bila konfigurasi memuat field "mcpServers", VibeKit menyambung ke server
  MCP lokal (stdio) maupun remote (HTTP) itu dan tool mereka tampil
  berdampingan dengan tool bawaan, bernama mcp__<server>__<tool>. Tool MCP
  diperlakukan sebagai aksi: selalu meminta persetujuanmu, kecuali mode
  auto-allow. Perintah "vibekit mcp" menampilkan tool yang tersedia.

VibeKit Layani (server MCP — arah sebaliknya):
  "vibekit layani" menjalankan VibeKit sebagai SERVER MCP yang melayani
  folder tempat perintah dijalankan kepada agen AI eksternal (mis. Muse
  lewat konektor khusus, atau client MCP lain). Kelima tool mode agent
  tersedia dari jarak jauh, dengan pagar yang sama: token Bearer wajib,
  path tidak bisa keluar dari folder ini, dan aksi tulis/perintah meminta
  persetujuanmu di terminal server ini (kecuali --auto). Server berhenti
  total dengan Ctrl+C. Opsi:
    --port <n>     Port TCP (bawaan: config layani.port, atau 3939)
    --host <h>     Alamat bind (bawaan: config layani.host, atau 127.0.0.1;
                   isi alamat Tailscale komputermu untuk akses jarak jauh)
    --token <t>    Token Bearer (bawaan: env VIBEKIT_LAYANI_TOKEN, atau
                   config layani.token — dibuat & disimpan otomatis bila
                   belum ada)
    --auto, --yes  Lewati persetujuan terminal untuk aksi tulis/perintah

Cara kerja singkat:
  Penyedia dicoba sesuai urutan di konfigurasi. Bila kuota penyedia terdeteksi
  habis, permintaan otomatis diulang ke penyedia berikutnya. Setiap jawaban
  diatur ringkas (poin-poin penting) dan dibatasi tokennya agar hemat.
  Konfigurasi proyek ./vibekit.config.json menimpa konfigurasi global.
`);
}

function perintahInit(): number {
  const dibuat = buatConfigGlobal();
  if (dibuat) {
    console.log(teksBanner());
    console.log(`Konfigurasi dibuat: ${globalConfigPath()}`);
    console.log("Isi kolom \"apiKey\" untuk tiap penyedia yang ingin dipakai (atau pakai sintaks \"env:NAMA_VAR\").");
    console.log("Urutan penyedia = prioritas: yang pertama adalah bawaan, berikutnya cadangan failover.");
  } else {
    console.log(`Konfigurasi sudah ada di ${globalConfigPath()} — tidak ditimpa.`);
    console.log("Edit file itu langsung bila ingin mengubah penyedia, model, atau anggaran.");
  }
  return 0;
}

/** Satu baris peringatan yang dicetak di awal perintah saat mode auto-allow aktif. */
function cetakPeringatanAuto(): void {
  console.error(
    "[vibekit] Mode auto-allow AKTIF: aksi tulis file & menjalankan perintah akan dijalankan TANPA persetujuanmu. Agent tetap terkunci di folder kerja ini."
  );
}

function potongTeks(teks: string, maks: number): string {
  return teks.length > maks ? teks.slice(0, maks) + "…" : teks;
}

interface KoneksiMcpCli {
  toolEkstra: ToolDefinition[];
  eksekutorEkstra: (nama: string, argumen: Record<string, unknown>) => Promise<string>;
  tutup: () => Promise<void>;
}

/**
 * Sambungkan server MCP dari konfigurasi (bila ada) dan siapkan tool ekstra
 * untuk loop agent. Satu baris ringkas dicetak per server (`MCP <nama>: N
 * tool`); kegagalan per server tampil sebagai peringatan dan tidak
 * menggagalkan perintah. Kembalikan null bila konfigurasi tanpa mcpServers.
 * Pemanggil WAJIB memanggil `tutup()` saat selesai (try/finally).
 */
async function siapkanMcp(config: VibekitConfig): Promise<KoneksiMcpCli | null> {
  if (!config.mcpServers || config.mcpServers.length === 0) return null;
  const pengelola = await sambungkanMcpServers(config.mcpServers);
  for (const r of pengelola.rincianServer) {
    console.error(`[vibekit] MCP ${r.nama}: ${r.tools.length} tool`);
  }
  for (const p of pengelola.peringatan) {
    console.error(`[vibekit] MCP peringatan: ${p}`);
  }
  return {
    toolEkstra: pengelola.tools,
    eksekutorEkstra: (nama, argumen) => pengelola.panggilTool(nama, argumen),
    tutup: () => pengelola.tutupSemua(),
  };
}

interface OpsiAsk {
  pertanyaan: string;
  files: string[];
  dirs: string[];
  auto: boolean;
  tanpaBrief: boolean;
}

function uraiArgAsk(args: string[]): OpsiAsk | { error: string } {
  const files: string[] = [];
  const dirs: string[] = [];
  const sisa: string[] = [];
  let auto = false;
  let tanpaBrief = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--file") {
      const v = args[++i];
      if (!v) return { error: "Opsi --file membutuhkan path file." };
      files.push(v);
    } else if (a === "--dir") {
      const v = args[++i];
      if (!v) return { error: "Opsi --dir membutuhkan path folder." };
      dirs.push(v);
    } else if (a.startsWith("--file=")) {
      files.push(a.slice("--file=".length));
    } else if (a.startsWith("--dir=")) {
      dirs.push(a.slice("--dir=".length));
    } else if (a === "--auto" || a === "--yes") {
      auto = true;
    } else if (a === "--tanpa-brief") {
      tanpaBrief = true;
    } else {
      sisa.push(a);
    }
  }
  const pertanyaan = sisa.join(" ").trim();
  if (!pertanyaan) return { error: "Pertanyaan kosong. Contoh: vibekit ask \"apa itu API?\"" };
  return { pertanyaan, files, dirs, auto, tanpaBrief };
}

/**
 * Siapkan pesan konteks brief proyek (.vibekit/brief.md di cwd) untuk
 * disuntikkan setelah system prompt. Mengembalikan teks pesan system, atau
 * null bila brief tidak ada / dilewatkan lewat --tanpa-brief. Satu baris
 * info dicetak ke stderr saat brief dipakai.
 */
function siapkanKonteksBrief(cwd: string, tanpaBrief: boolean): string | null {
  if (tanpaBrief) return null;
  const brief = muatKonteksBrief(cwd);
  if (!brief) return null;
  console.error(`[vibekit] (memakai brief proyek: ±${formatAngka(brief.token)} token)`);
  return brief.teks;
}

/**
 * Pembaca baris stdin yang serial: SATU antrean konsumen untuk semua
 * kebutuhan (prompt utama chat maupun pertanyaan konfirmasi tool di tengah
 * giliran), agar keduanya tidak berebut baris masukan. `tanya` menulis
 * prompt lalu menunggu satu baris; mengembalikan null bila stdin berakhir
 * (EOF) — pemanggil menafsirkannya sebagai berhenti (loop utama) atau
 * menolak (konfirmasi), keduanya aman.
 */
interface PembacaBaris {
  tanya: (prompt: string) => Promise<string | null>;
  tutup: () => void;
}

function buatPembacaBaris(): PembacaBaris {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const antrian: string[] = [];
  const penunggu: Array<(baris: string | null) => void> = [];
  let berakhir = false;
  rl.on("line", (baris) => {
    const p = penunggu.shift();
    if (p) p(baris);
    else antrian.push(baris);
  });
  rl.on("close", () => {
    berakhir = true;
    while (penunggu.length > 0) (penunggu.shift() as (b: string | null) => void)(null);
  });
  return {
    tanya: (prompt: string) => {
      process.stdout.write(prompt);
      const siap = antrian.shift();
      if (siap !== undefined) return Promise.resolve(siap);
      if (berakhir) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => penunggu.push(resolve));
    },
    tutup: () => rl.close(),
  };
}

/** Pembuat callback konfirmasi bersama untuk do/ask/chat di atas satu PembacaBaris. */
function buatKonfirmasi(pembaca: PembacaBaris): Konfirmasi {
  return async (deskripsi: string): Promise<boolean> => {
    console.log(`\n[vibekit] Usulan aksi:\n${deskripsi}`);
    const jawaban = await pembaca.tanya("Jalankan? (y/N) ");
    if (jawaban === null) return false; // EOF: tolak demi keamanan
    const j = jawaban.trim().toLowerCase();
    return j === "y" || j === "ya";
  };
}

async function perintahAsk(args: string[]): Promise<number> {
  const urai = uraiArgAsk(args);
  if ("error" in urai) {
    console.error(`[vibekit] ${urai.error}`);
    return 2;
  }
  let config: VibekitConfig;
  try {
    config = muatConfig().config;
  } catch (e) {
    console.error(`[vibekit] ${(e as Error).message}`);
    return 2;
  }

  let isiUser = urai.pertanyaan;
  const target = [...urai.files, ...urai.dirs];
  if (target.length > 0) {
    const konteks = bangunKonteks(target);
    if (konteks.jumlahFile > 0) {
      const hemat =
        konteks.tokenMentah > 0
          ? Math.max(0, Math.round((1 - konteks.tokenTerseleksi / konteks.tokenMentah) * 100))
          : 0;
      console.error(
        `[vibekit] konteks: ${konteks.jumlahFile} file • token mentah ${formatAngka(konteks.tokenMentah)} → terseleksi ${formatAngka(konteks.tokenTerseleksi)} (hemat ${hemat}%)`
      );
      isiUser = `Konteks proyek:\n\n${konteks.teks}\n\nPertanyaan: ${urai.pertanyaan}`;
    }
    for (const d of konteks.dilewati) console.error(`[vibekit] konteks dilewati: ${d}`);
  }

  // Sejak v0.3.0 ask menjalankan SATU giliran agent: pertanyaan biasa dijawab
  // teks langsung, permintaan membuat file/perintah dijalankan lewat tool
  // dengan konfirmasi — pagar keamanan yang sama seperti `do`.
  const cwd = process.cwd();
  const konteksBrief = siapkanKonteksBrief(cwd, urai.tanpaBrief);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT_GABUNGAN },
    ...(konteksBrief ? [{ role: "system", content: konteksBrief } as ChatMessage] : []),
    { role: "user", content: isiUser },
  ];
  if (urai.auto) cetakPeringatanAuto();
  const mcp = await siapkanMcp(config);
  const pembaca = buatPembacaBaris();
  try {
    // Jawaban dialirkan (streaming) ke stdout potongan demi potongan; jejak
    // langkah tetap ke stderr agar stdout bersih untuk jawaban.
    let sudahMengalir = false;
    const hasil = await jalankanGiliran({
      config,
      messages,
      lokasiState: statePath(),
      cwd,
      konfirmasi: buatKonfirmasi(pembaca),
      autoAllow: urai.auto,
      jejak: (pesan) => console.error(`[vibekit] ${pesan}`),
      stream: true,
      onToken: (potongan) => {
        sudahMengalir = true;
        process.stdout.write(potongan);
      },
      ...(mcp ? { toolEkstra: mcp.toolEkstra, eksekutorEkstra: mcp.eksekutorEkstra } : {}),
    });
    if (!hasil.ok) {
      if (sudahMengalir) process.stdout.write("\n");
      if (hasil.batasTercapai) {
        console.error(
          `[vibekit] Batas langkah tercapai (${hasil.jumlahLangkah} langkah) sebelum pertanyaan ini selesai dikerjakan. Persempit permintaanmu, atau gunakan vibekit do untuk mode tugas.`
        );
      } else {
        console.error(hasil.pesanGagal ?? "[vibekit] Semua penyedia gagal atau sedang tidak tersedia.");
      }
      return 1;
    }
    if (sudahMengalir) {
      process.stdout.write("\n");
    } else {
      console.log(hasil.jawabanAkhir);
    }
    if (hasil.providerTerakhir) {
      const sumber = hasil.tokenSumber === "usage" ? "dari usage API" : "estimasi";
      console.log(
        `\n— dijawab oleh ${hasil.providerTerakhir.nama} (${hasil.providerTerakhir.model}) • ${formatAngka(hasil.totalToken)} token (${sumber})`
      );
    }
    for (const c of hasil.catatan) {
      console.error(`[vibekit] dilewati ${c.nama}: ${c.alasan}`);
    }
    return 0;
  } finally {
    pembaca.tutup();
    if (mcp) await mcp.tutup();
  }
}

async function perintahChat(args: string[]): Promise<number> {
  let config: VibekitConfig;
  try {
    config = muatConfig().config;
  } catch (e) {
    console.error(`[vibekit] ${(e as Error).message}`);
    return 2;
  }
  // Mode auto-allow bisa dinyalakan dari flag --auto/--yes, lalu diubah
  // kapan saja di tengah sesi dengan perintah /auto.
  let autoAktif = args.includes("--auto") || args.includes("--yes");
  const lanjut = args.includes("--lanjut");
  const tanpaBrief = args.includes("--tanpa-brief");
  const cwd = process.cwd();
  const dirSesi = folderSesi(configDir());

  console.log("VibeKit chat — ketik pertanyaan, /keluar untuk berhenti.");
  console.log("Chat ini juga bisa bertindak: minta saja dibuatkan file atau menjalankan perintah — setiap aksi meminta persetujuanmu dulu.");
  console.log("Perintah /auto menyalakan/mematikan mode auto-allow (aksi tanpa persetujuan) di tengah sesi; /sesi menampilkan id sesi aktif.");
  if (autoAktif) cetakPeringatanAuto();

  // Sesi: --lanjut memulihkan sesi terakhir yang tersimpan (riwayat internal
  // apa adanya, termasuk pesan mentah tool agar thought_signature utuh);
  // tanpa --lanjut, sesi baru dimulai. Sesi disimpan SETELAH setiap giliran
  // berhasil — sesi yang belum pernah berhasil tidak meninggalkan file.
  let sesiAktif: SesiChat;
  const riwayat: ChatMessage[] = [];
  if (lanjut) {
    const tersimpan = muatSesiTerakhir(dirSesi);
    if (tersimpan) {
      sesiAktif = tersimpan;
      riwayat.push(...tersimpan.pesan);
      const jumlahIsi = tersimpan.pesan.filter((m) => m.role !== "system").length;
      console.log(
        `[vibekit] Sesi dilanjutkan: ${tersimpan.id} — ${jumlahIsi} pesan dipulihkan (terakhir diperbarui ${new Date(tersimpan.diperbarui).toLocaleString("id-ID")}).`
      );
    } else {
      console.log("[vibekit] Belum ada sesi tersimpan — memulai sesi chat baru.");
      sesiAktif = { id: buatIdSesi(), dibuat: new Date().toISOString(), diperbarui: new Date().toISOString(), pesan: [] };
      riwayat.push({ role: "system", content: SYSTEM_PROMPT_GABUNGAN });
    }
  } else {
    sesiAktif = { id: buatIdSesi(), dibuat: new Date().toISOString(), diperbarui: new Date().toISOString(), pesan: [] };
    riwayat.push({ role: "system", content: SYSTEM_PROMPT_GABUNGAN });
  }

  // Brief proyek disuntikkan SEKALI di awal sesi (setelah system prompt),
  // kecuali sudah ada di riwayat sesi yang dilanjutkan.
  const briefSudahAda = riwayat.some(
    (m) => typeof m.content === "string" && m.content.startsWith(AWALAN_KONTEKS_BRIEF)
  );
  if (!briefSudahAda) {
    const konteksBrief = siapkanKonteksBrief(cwd, tanpaBrief);
    if (konteksBrief) riwayat.splice(1, 0, { role: "system", content: konteksBrief });
  }

  // Server MCP disambungkan SEKALI untuk seluruh sesi chat ini.
  const mcp = await siapkanMcp(config);
  const pembaca = buatPembacaBaris();
  const konfirmasi = buatKonfirmasi(pembaca);
  try {
    for (;;) {
      const barisMentah = await pembaca.tanya("kamu> ");
      if (barisMentah === null) break; // stdin berakhir (EOF)
      const baris = barisMentah.trim();
      if (baris === "/keluar" || baris === "/exit") break;
      if (!baris) continue;
      if (baris === "/auto") {
        autoAktif = !autoAktif;
        console.log(
          autoAktif
            ? "[vibekit] Mode auto-allow: AKTIF — aksi tulis file & menjalankan perintah berikutnya dijalankan TANPA persetujuan. Agent tetap terkunci di folder kerja ini."
            : "[vibekit] Mode auto-allow: NONAKTIF — aksi tulis file & menjalankan perintah kembali meminta persetujuanmu satu per satu."
        );
        continue;
      }
      if (baris === "/sesi") {
        console.log(`[vibekit] Sesi aktif: ${sesiAktif.id} (tersimpan otomatis setelah setiap giliran berhasil; lanjutkan kapan pun dengan: vibekit chat --lanjut)`);
        continue;
      }
      riwayat.push({ role: "user", content: baris });

      // Kompaksi riwayat aksi DULU: rangkaian tool giliran-giliran lama
      // diganti ringkasan satu baris agar isi file tidak terkirim ulang.
      // Giliran terakhir (yang baru saja ditambahkan pesan user-nya ini
      // menjadi giliran terakhir) tidak disentuh kompaksi. Token yang
      // terbuang DIUKUR dan diakumulasikan ke state (laporan `vibekit hemat`).
      const terkompaksi = kompaksiRiwayatAksiTerukur(riwayat);
      riwayat.splice(0, riwayat.length, ...terkompaksi.riwayat);
      if (terkompaksi.tokenTerbuang > 0) {
        try {
          catatHematKompaksi(statePath(), terkompaksi.tokenTerbuang);
        } catch {
          /* pencatatan hemat gagal tidak boleh menggagalkan giliran */
        }
      }

      // Lalu Pangkas SADAR-TOOL: hanya pada batas giliran utuh, tidak pernah
      // menyisakan pesan tool yatim atau tool_calls tanpa hasilnya.
      const terpotong = pangkasRiwayatAman(riwayat, BATAS_TOKEN_RIWAYAT);
      riwayat.splice(0, riwayat.length, ...terpotong);

      // Jawaban dialirkan (streaming): header dicetak saat token pertama
      // tiba dari penyedia pemenang (bukan sebelumnya, agar nama penyedia
      // tidak salah saat failover), lalu potongan teks menyusul apa adanya.
      let sudahMengalir = false;
      const hasil = await jalankanGiliran({
        config,
        messages: riwayat,
        lokasiState: statePath(),
        cwd,
        konfirmasi,
        autoAllow: autoAktif,
        jejak: (pesan) => console.error(`[vibekit] ${pesan}`),
        stream: true,
        onTokenPertama: (provider: ProviderConfig) => {
          // Header hanya dicetak SEKALI per giliran, pada token pertama dari
          // panggilan router mana pun yang lebih dulu mengeluarkan teks.
          if (sudahMengalir) return;
          sudahMengalir = true;
          process.stdout.write(`\nvibekit (${provider.nama})> `);
        },
        onToken: (potongan) => process.stdout.write(potongan),
        ...(mcp ? { toolEkstra: mcp.toolEkstra, eksekutorEkstra: mcp.eksekutorEkstra } : {}),
      });
      if (hasil.ok) {
        if (sudahMengalir) {
          process.stdout.write("\n\n");
        } else {
          console.log(`\nvibekit (${hasil.providerTerakhir?.nama ?? "?"})> ${hasil.jawabanAkhir}\n`);
        }
        // Simpan sesi SETELAH giliran berhasil (riwayat sudah terkompaksi).
        sesiAktif.diperbarui = new Date().toISOString();
        sesiAktif.pesan = [...riwayat];
        try {
          simpanSesi(dirSesi, sesiAktif);
        } catch {
          /* kegagalan menyimpan sesi tidak menggagalkan percakapan */
        }
      } else {
        if (sudahMengalir) process.stdout.write("\n");
        // Giliran gagal/batas tercapai: gulung balik SELURUH giliran ini
        // (pesan user + rangkaian parsialnya) agar riwayat tetap bersih.
        let idxUser = -1;
        for (let i = riwayat.length - 1; i >= 0; i--) {
          if (riwayat[i].role === "user") {
            idxUser = i;
            break;
          }
        }
        if (idxUser >= 0) riwayat.length = idxUser;
        const pesan = hasil.batasTercapai
          ? `Batas langkah tercapai (${hasil.jumlahLangkah} langkah) pada giliran ini; giliran dibatalkan. Persempit permintaanmu.`
          : (hasil.pesanGagal ?? "Semua penyedia gagal atau sedang tidak tersedia.");
        console.error(`\n${pesan}\n`);
      }
    }
  } finally {
    pembaca.tutup();
    if (mcp) await mcp.tutup();
  }
  return 0;
}

async function perintahDo(args: string[]): Promise<number> {
  const auto = args.includes("--auto") || args.includes("--yes");
  const rencana = args.includes("--rencana");
  const tanpaBrief = args.includes("--tanpa-brief");
  const FLAG_DO = new Set(["--auto", "--yes", "--rencana", "--tanpa-brief"]);
  const tugas = args
    .filter((a) => !FLAG_DO.has(a))
    .join(" ")
    .trim();
  if (!tugas) {
    console.error("[vibekit] Tugas kosong. Contoh: vibekit do \"buatkan file halo.txt berisi sapaan\"");
    return 2;
  }
  let config: VibekitConfig;
  try {
    config = muatConfig().config;
  } catch (e) {
    console.error(`[vibekit] ${(e as Error).message}`);
    return 2;
  }
  const cwd = process.cwd();
  console.log(`VibeKit agent — folder kerja: ${cwd}`);
  console.log(`Tugas: ${tugas}`);
  if (rencana) {
    console.log("Mode rencana: agent menyusun rencana dulu dan meminta persetujuanmu SATU kali sebelum menjalankan apa pun.\n");
  } else if (auto) {
    cetakPeringatanAuto();
  } else {
    console.log("Tool baca berjalan langsung; tulis/edit file dan jalankan perintah meminta persetujuanmu satu per satu.\n");
  }
  const konteksBrief = siapkanKonteksBrief(cwd, tanpaBrief);

  const mcp = await siapkanMcp(config);
  const pembaca = buatPembacaBaris();
  const konfirmasi = buatKonfirmasi(pembaca);
  // Ringkasan akhir dialirkan (streaming) ke stdout; jejak tetap ke stderr.
  let sudahMengalir = false;
  const onToken = (potongan: string) => {
    sudahMengalir = true;
    process.stdout.write(potongan);
  };

  try {
    if (rencana) {
      const hasil = await jalankanAgentRencana({
        config,
        tugas,
        lokasiState: statePath(),
        cwd,
        konfirmasi,
        konfirmasiRencana: async (teksRencana: string): Promise<boolean> => {
          console.log("\n— rencana agent —");
          console.log(teksRencana);
          const jawaban = await pembaca.tanya("\nJalankan rencana ini? (y/N) ");
          if (jawaban === null) return false; // EOF: tolak demi keamanan
          const j = jawaban.trim().toLowerCase();
          if (j !== "y" && j !== "ya") return false;
          console.error(
            "[vibekit] Rencana disetujui — eksekusi berjalan TANPA konfirmasi per langkah (mode auto-allow khusus rencana ini). Pagar folder kerja tetap berlaku."
          );
          return true;
        },
        jejak: (pesan) => console.error(`[vibekit] ${pesan}`),
        stream: true,
        onToken,
        ...(konteksBrief ? { konteksSistem: konteksBrief } : {}),
        ...(mcp ? { toolEkstra: mcp.toolEkstra, eksekutorEkstra: mcp.eksekutorEkstra } : {}),
      });
      for (const c of hasil.catatan) {
        console.error(`[vibekit] dilewati ${c.nama}: ${c.alasan}`);
      }
      if (hasil.status === "dibatalkan") {
        console.log("\nDibatalkan — rencana tidak dijalankan, tidak ada perubahan apa pun.");
        return 0;
      }
      if (sudahMengalir) {
        process.stdout.write("\n");
        if (hasil.status !== "selesai") console.error(`[vibekit] ${hasil.ringkasan}`);
      } else {
        console.log(`\n— ringkasan agent (${hasil.jumlahLangkah} langkah) —`);
        console.log(hasil.ringkasan);
      }
      return hasil.status === "selesai" ? 0 : 1;
    }

    const hasil = await jalankanAgent({
      config,
      tugas,
      lokasiState: statePath(),
      cwd,
      konfirmasi,
      autoAllow: auto,
      jejak: (pesan) => console.error(`[vibekit] ${pesan}`),
      stream: true,
      onToken,
      ...(konteksBrief ? { konteksSistem: konteksBrief } : {}),
      ...(mcp ? { toolEkstra: mcp.toolEkstra, eksekutorEkstra: mcp.eksekutorEkstra } : {}),
    });
    for (const c of hasil.catatan) {
      console.error(`[vibekit] dilewati ${c.nama}: ${c.alasan}`);
    }
    if (sudahMengalir) {
      process.stdout.write("\n");
      if (!hasil.ok) console.error(`[vibekit] ${hasil.ringkasan}`);
    } else {
      console.log(`\n— ringkasan agent (${hasil.jumlahLangkah} langkah) —`);
      console.log(hasil.ringkasan);
    }
    return hasil.ok ? 0 : 1;
  } finally {
    pembaca.tutup();
    if (mcp) await mcp.tutup();
  }
}

/**
 * `vibekit mcp`: sambungkan semua server MCP dari konfigurasi, cetak daftar
 * tool per server (nama ter-namespace + deskripsi singkat), lalu putuskan.
 */
async function perintahMcp(): Promise<number> {
  let config: VibekitConfig;
  try {
    config = muatConfig().config;
  } catch (e) {
    console.error(`[vibekit] ${(e as Error).message}`);
    return 2;
  }
  const daftar = config.mcpServers ?? [];
  if (daftar.length === 0) {
    console.log("Belum ada server MCP di konfigurasi.");
    console.log(
      "Tambahkan field \"mcpServers\" pada file konfigurasi — tiap entri adalah server lokal (stdio, lewat \"perintah\") atau remote (HTTP, lewat \"url\"). Contoh minimal:"
    );
    console.log(
      JSON.stringify(
        {
          mcpServers: [
            {
              nama: "filesystem",
              perintah: "npx",
              argumen: ["-y", "@modelcontextprotocol/server-filesystem", "."],
            },
          ],
        },
        null,
        2
      )
    );
    console.log("Lihat bagian \"Dukungan MCP\" di README untuk contoh lengkap, termasuk server remote.");
    return 0;
  }
  const pengelola = await sambungkanMcpServers(daftar);
  try {
    for (const r of pengelola.rincianServer) {
      console.log(`\nMCP ${r.nama} — ${r.tools.length} tool:`);
      for (const t of r.tools) {
        console.log(`  ${t.namaLengkap}${t.deskripsi ? ` — ${potongTeks(t.deskripsi, 80)}` : ""}`);
      }
    }
    for (const p of pengelola.peringatan) {
      console.error(`[vibekit] MCP peringatan: ${p}`);
    }
    if (pengelola.rincianServer.length === 0) {
      console.error("[vibekit] Tidak ada server MCP yang berhasil tersambung.");
      return 1;
    }
    return 0;
  } finally {
    await pengelola.tutupSemua();
  }
}

/** `vibekit hemat`: laporan pemakaian token + penghematan terukur dari state lokal. */
function perintahHemat(): number {
  const state = muatState(statePath());
  console.log(bangunLaporanHemat(state, new Date()));
  return 0;
}

/** `vibekit sesi`: daftar sesi chat tersimpan, terbaru lebih dulu. */
function perintahSesi(): number {
  const daftar = daftarSesi(folderSesi(configDir()));
  if (daftar.length === 0) {
    console.log("Belum ada sesi chat tersimpan. Sesi tersimpan otomatis setelah giliran chat pertama yang berhasil.");
    console.log("Lanjutkan sesi terakhir kapan pun dengan: vibekit chat --lanjut");
    return 0;
  }
  console.log(`Sesi chat tersimpan (${daftar.length}):`);
  for (const s of daftar) {
    const waktu = new Date(s.diperbarui).toLocaleString("id-ID");
    console.log(`  ${s.id} • ${waktu} • ${s.jumlahPesan} pesan${s.cuplikan ? ` • "${s.cuplikan}"` : ""}`);
  }
  console.log("\nLanjutkan sesi terakhir dengan: vibekit chat --lanjut");
  return 0;
}

/** `vibekit brief`: pindai folder kerja saat ini dan tulis .vibekit/brief.md. */
function perintahBrief(): number {
  const hasil = buatBrief(process.cwd());
  console.log(`Brief proyek ditulis: ${hasil.lokasi}`);
  console.log(`Isi: ${hasil.jumlahFile} file terpindai • ±${formatAngka(hasil.token)} token.`);
  console.log("Brief ini dipakai otomatis sebagai konteks pada ask/chat/do berikutnya (lewatkan dengan --tanpa-brief).");
  return 0;
}

interface UraiLayani {
  port?: number;
  host?: string;
  token?: string;
  auto: boolean;
}

function uraiArgLayani(args: string[]): UraiLayani | { error: string } {
  const hasil: UraiLayani = { auto: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--auto" || a === "--yes") {
      hasil.auto = true;
    } else if (a === "--port") {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v < 0 || v > 65535) return { error: "Nilai --port harus bilangan 0–65535." };
      hasil.port = v;
    } else if (a === "--host") {
      const v = args[++i];
      if (!v) return { error: "Opsi --host membutuhkan nilai." };
      hasil.host = v;
    } else if (a === "--token") {
      const v = args[++i];
      if (!v) return { error: "Opsi --token membutuhkan nilai." };
      hasil.token = v;
    } else {
      return { error: `Opsi layani tidak dikenal: ${a}` };
    }
  }
  return hasil;
}

/**
 * Perintah `vibekit layani`: jalankan server MCP yang melayani folder kerja
 * saat ini ke agen AI eksternal. Berbeda dari perintah lain, layani TIDAK
 * mewajibkan konfigurasi providers — ia hanya butuh token, yang dibuat dan
 * disimpan otomatis ke konfigurasi global bila belum ada. Server hidup
 * sampai Ctrl+C (SIGINT/SIGTERM).
 */
async function perintahLayani(args: string[]): Promise<number> {
  const urai = uraiArgLayani(args);
  if ("error" in urai) {
    console.error(`[vibekit] ${urai.error}`);
    return 2;
  }
  // Konfigurasi dibaca longgar: kegagalan muat (belum init, dsb.) tidak
  // menggagalkan layani — nilai bawaan dipakai, token tetap bisa dibuat.
  let config: VibekitConfig | null = null;
  try {
    config = muatConfig().config;
  } catch {
    config = null;
  }
  const dariConfig = config?.layani ?? {};
  const token =
    urai.token ??
    (process.env.VIBEKIT_LAYANI_TOKEN || undefined) ??
    dariConfig.token ??
    (() => {
      const baru = buatTokenLayani();
      try {
        simpanTokenLayani(baru);
        console.log("[vibekit] Token layani baru dibuat dan disimpan di ~/.vibekit/config.json (field layani.token).");
      } catch (e) {
        console.error(
          `[vibekit] Token baru dibuat tetapi gagal disimpan (${(e as Error).message}); catat token di bawah ini baik-baik.`
        );
      }
      return baru;
    })();
  const host = urai.host ?? dariConfig.host ?? "127.0.0.1";
  const port = urai.port ?? dariConfig.port ?? 3939;
  const cwd = process.cwd();

  const pembaca = buatPembacaBaris();
  const konfirmasi = buatKonfirmasi(pembaca);
  let server: Awaited<ReturnType<typeof mulaiServerLayani>>;
  try {
    server = await mulaiServerLayani({
      cwd,
      host,
      port,
      token,
      versi: VERSI,
      konfirmasi,
      autoAllow: urai.auto,
    });
  } catch (e) {
    pembaca.tutup();
    console.error(`[vibekit] Gagal memulai server layani: ${(e as Error).message}`);
    return 1;
  }

  console.log(`\n[vibekit] Server layani AKTIF — melayani folder: ${cwd}`);
  console.log(`[vibekit] Alamat : http://${server.host}:${server.port}/`);
  console.log(`[vibekit] Token  : ${token}`);
  console.log(
    "[vibekit] Daftarkan alamat + token ini sebagai server MCP (transport Streamable HTTP, header Authorization: Bearer <token>) pada agen/client-mu."
  );
  if (host === "127.0.0.1") {
    console.log(
      "[vibekit] Catatan: bind 127.0.0.1 hanya bisa dijangkau dari komputer ini. Untuk akses jarak jauh (mis. lewat Tailscale), jalankan ulang dengan --host <alamat-tailscale-komputermu>."
    );
  }
  console.log(
    urai.auto
      ? "[vibekit] Mode AUTO aktif: aksi tulis/perintah dari client langsung dijalankan TANPA persetujuan. Pagar folder tetap berlaku."
      : "[vibekit] Aksi tulis_file / edit_file / jalankan_perintah dari client akan meminta persetujuanmu di terminal ini."
  );
  console.log("[vibekit] Tekan Ctrl+C untuk berhenti dan memutus akses sepenuhnya.\n");

  await new Promise<void>((resolve) => {
    const berhenti = () => resolve();
    process.once("SIGINT", berhenti);
    process.once("SIGTERM", berhenti);
  });
  await server.tutup();
  pembaca.tutup();
  console.log("\n[vibekit] Server layani berhenti. Akses terputus.");
  return 0;
}

function perintahStatus(): number {
  let config: VibekitConfig;
  try {
    config = muatConfig().config;
  } catch (e) {
    console.error(`[vibekit] ${(e as Error).message}`);
    return 2;
  }
  const state = muatState(statePath());
  const sekarang = new Date();
  const baris: string[][] = [["Penyedia", "Model", "Status", "Token hari ini"]];
  for (const p of config.providers) {
    const entri = statePenyedia(state, p.nama, sekarang);
    let status = "aktif";
    if (sedangCooldown(entri, sekarang) && entri.cooldownUntil) {
      status = `cooldown s.d. ${formatJam(entri.cooldownUntil)}`;
    } else if (typeof p.anggaranHarian === "number" && entri.totalToken >= p.anggaranHarian) {
      status = "anggaran harian tercapai";
    }
    baris.push([p.nama, p.model, status, formatAngka(entri.totalToken)]);
  }
  const lebar = baris[0].map((_, i) => Math.max(...baris.map((b) => b[i].length)));
  for (const b of baris) {
    console.log(b.map((sel, i) => sel.padEnd(lebar[i])).join("  "));
  }
  return 0;
}

async function utama(): Promise<number> {
  const [perintah, ...sisa] = process.argv.slice(2);
  switch (perintah) {
    case "init":
      return perintahInit();
    case "ask":
      return perintahAsk(sisa);
    case "chat":
      return perintahChat(sisa);
    case "do":
      return perintahDo(sisa);
    case "mcp":
      return perintahMcp();
    case "layani":
      return perintahLayani(sisa);
    case "brief":
      return perintahBrief();
    case "hemat":
      return perintahHemat();
    case "sesi":
      return perintahSesi();
    case "status":
      return perintahStatus();
    case "--version":
    case "-v":
      console.log(VERSI);
      return 0;
    case "--help":
    case "-h":
    case "help":
    case undefined:
      bantuan();
      return 0;
    default:
      console.error(`[vibekit] Perintah tidak dikenal: ${perintah}\n`);
      bantuan();
      return 2;
  }
}

utama()
  .then((kode) => {
    process.exitCode = kode;
  })
  .catch((e) => {
    console.error(`[vibekit] Kesalahan tak terduga: ${(e as Error).message}`);
    process.exitCode = 1;
  });
