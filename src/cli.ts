#!/usr/bin/env node
import readline from "node:readline";
import {
  buatConfigGlobal,
  globalConfigPath,
  muatConfig,
  statePath,
} from "./config.js";
import {
  jalankanAgent,
  jalankanGiliran,
  kompaksiRiwayatAksi,
  pangkasRiwayatAman,
  SYSTEM_PROMPT_GABUNGAN,
  type Konfirmasi,
} from "./agent.js";
import { teksBanner } from "./banner.js";
import { bangunKonteks } from "./context.js";
import {
  formatJam,
  muatState,
  sedangCooldown,
  statePenyedia,
} from "./state.js";
import { formatAngka } from "./token.js";
import type { ChatMessage, VibekitConfig } from "./types.js";

const VERSI = "0.4.1";
const BATAS_TOKEN_RIWAYAT = 4000;

function bantuan(): void {
  console.log(`VibeKit CLI v${VERSI} — router AI hemat token dengan failover otomatis

Penggunaan:
  vibekit init                          Buat ~/.vibekit/config.json dari template
  vibekit ask "<pertanyaan>" [opsi]     Tanya sekali (bisa bertindak: membuat file & menjalankan perintah dengan persetujuanmu)
  vibekit chat                          Percakapan interaktif yang juga bisa bertindak (perintah /keluar untuk berhenti)
  vibekit do "<tugas>"                  Mode agent sekali jalan: kerjakan tugas dengan tool file/perintah di folder ini
  vibekit status                        Status & pemakaian token tiap penyedia hari ini
  vibekit --help                        Tampilkan bantuan ini
  vibekit --version                     Tampilkan versi

Opsi ask:
  --file <path>    Lampirkan file sebagai konteks (boleh diulang)
  --dir <path>     Lampirkan isi folder sebagai konteks (boleh diulang)
  --auto, --yes    Mode auto-allow: aksi tulis/perintah langsung dijalankan
                   tanpa persetujuan (tetap terkunci di folder kerja)

Opsi chat & do:
  --auto, --yes    Mode auto-allow seperti di atas. Di tengah sesi chat,
                   perintah /auto menyalakan/mematikan mode ini kapan saja.

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

interface OpsiAsk {
  pertanyaan: string;
  files: string[];
  dirs: string[];
  auto: boolean;
}

function uraiArgAsk(args: string[]): OpsiAsk | { error: string } {
  const files: string[] = [];
  const dirs: string[] = [];
  const sisa: string[] = [];
  let auto = false;
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
    } else {
      sisa.push(a);
    }
  }
  const pertanyaan = sisa.join(" ").trim();
  if (!pertanyaan) return { error: "Pertanyaan kosong. Contoh: vibekit ask \"apa itu API?\"" };
  return { pertanyaan, files, dirs, auto };
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
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT_GABUNGAN },
    { role: "user", content: isiUser },
  ];
  if (urai.auto) cetakPeringatanAuto();
  const pembaca = buatPembacaBaris();
  try {
    const hasil = await jalankanGiliran({
      config,
      messages,
      lokasiState: statePath(),
      cwd: process.cwd(),
      konfirmasi: buatKonfirmasi(pembaca),
      autoAllow: urai.auto,
      jejak: (pesan) => console.error(`[vibekit] ${pesan}`),
    });
    if (!hasil.ok) {
      if (hasil.batasTercapai) {
        console.error(
          `[vibekit] Batas langkah tercapai (${hasil.jumlahLangkah} langkah) sebelum pertanyaan ini selesai dikerjakan. Persempit permintaanmu, atau gunakan vibekit do untuk mode tugas.`
        );
      } else {
        console.error(hasil.pesanGagal ?? "[vibekit] Semua penyedia gagal atau sedang tidak tersedia.");
      }
      return 1;
    }
    console.log(hasil.jawabanAkhir);
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
  console.log("VibeKit chat — ketik pertanyaan, /keluar untuk berhenti.");
  console.log("Chat ini juga bisa bertindak: minta saja dibuatkan file atau menjalankan perintah — setiap aksi meminta persetujuanmu dulu.");
  console.log("Perintah /auto menyalakan/mematikan mode auto-allow (aksi tanpa persetujuan) di tengah sesi.");
  if (autoAktif) cetakPeringatanAuto();
  const riwayat: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT_GABUNGAN }];
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
      riwayat.push({ role: "user", content: baris });

      // Kompaksi riwayat aksi DULU: rangkaian tool giliran-giliran lama
      // diganti ringkasan satu baris agar isi file tidak terkirim ulang.
      // Giliran terakhir (yang baru saja ditambahkan pesan user-nya ini
      // menjadi giliran terakhir) tidak disentuh kompaksi.
      const terkompaksi = kompaksiRiwayatAksi(riwayat);
      riwayat.splice(0, riwayat.length, ...terkompaksi);

      // Lalu Pangkas SADAR-TOOL: hanya pada batas giliran utuh, tidak pernah
      // menyisakan pesan tool yatim atau tool_calls tanpa hasilnya.
      const terpotong = pangkasRiwayatAman(riwayat, BATAS_TOKEN_RIWAYAT);
      riwayat.splice(0, riwayat.length, ...terpotong);

      const hasil = await jalankanGiliran({
        config,
        messages: riwayat,
        lokasiState: statePath(),
        cwd: process.cwd(),
        konfirmasi,
        autoAllow: autoAktif,
        jejak: (pesan) => console.error(`[vibekit] ${pesan}`),
      });
      if (hasil.ok) {
        console.log(`\nvibekit (${hasil.providerTerakhir?.nama ?? "?"})> ${hasil.jawabanAkhir}\n`);
      } else {
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
  }
  return 0;
}

async function perintahDo(args: string[]): Promise<number> {
  const auto = args.includes("--auto") || args.includes("--yes");
  const tugas = args
    .filter((a) => a !== "--auto" && a !== "--yes")
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
  if (auto) {
    cetakPeringatanAuto();
  } else {
    console.log("Tool baca berjalan langsung; tulis/edit file dan jalankan perintah meminta persetujuanmu satu per satu.\n");
  }

  const pembaca = buatPembacaBaris();
  const konfirmasi = buatKonfirmasi(pembaca);

  try {
    const hasil = await jalankanAgent({
      config,
      tugas,
      lokasiState: statePath(),
      cwd,
      konfirmasi,
      autoAllow: auto,
      jejak: (pesan) => console.error(`[vibekit] ${pesan}`),
    });
    for (const c of hasil.catatan) {
      console.error(`[vibekit] dilewati ${c.nama}: ${c.alasan}`);
    }
    console.log(`\n— ringkasan agent (${hasil.jumlahLangkah} langkah) —`);
    console.log(hasil.ringkasan);
    return hasil.ok ? 0 : 1;
  } finally {
    pembaca.tutup();
  }
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
