#!/usr/bin/env node
import readline from "node:readline";
import {
  buatConfigGlobal,
  globalConfigPath,
  muatConfig,
  statePath,
} from "./config.js";
import { jalankanAgent } from "./agent.js";
import { bangunKonteks } from "./context.js";
import { tanyaRouter, type HasilTanya } from "./router.js";
import {
  formatJam,
  muatState,
  sedangCooldown,
  statePenyedia,
} from "./state.js";
import { formatAngka, hitungToken } from "./token.js";
import type { ChatMessage, VibekitConfig } from "./types.js";

const VERSI = "0.2.0";
const BATAS_TOKEN_RIWAYAT = 4000;

function bantuan(): void {
  console.log(`VibeKit CLI v${VERSI} — router AI hemat token dengan failover otomatis

Penggunaan:
  vibekit init                          Buat ~/.vibekit/config.json dari template
  vibekit ask "<pertanyaan>" [opsi]     Tanya sekali lewat router
  vibekit chat                          Percakapan interaktif (perintah /keluar untuk berhenti)
  vibekit do "<tugas>"                  Mode agent: kerjakan tugas dengan tool file/perintah di folder ini
  vibekit status                        Status & pemakaian token tiap penyedia hari ini
  vibekit --help                        Tampilkan bantuan ini
  vibekit --version                     Tampilkan versi

Opsi ask:
  --file <path>    Lampirkan file sebagai konteks (boleh diulang)
  --dir <path>     Lampirkan isi folder sebagai konteks (boleh diulang)

Mode agent (do):
  Agent bekerja HANYA di folder tempat perintah dijalankan. Tool baca
  (daftar_file, baca_file) berjalan langsung; tool yang mengubah sesuatu
  (tulis_file, edit_file, jalankan_perintah) selalu meminta persetujuanmu
  satu per satu — jawaban selain y/ya berarti ditolak. Batas 12 langkah.
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
    console.log(`Konfigurasi dibuat: ${globalConfigPath()}`);
    console.log("Isi kolom \"apiKey\" untuk tiap penyedia yang ingin dipakai (atau pakai sintaks \"env:NAMA_VAR\").");
    console.log("Urutan penyedia = prioritas: yang pertama adalah bawaan, berikutnya cadangan failover.");
  } else {
    console.log(`Konfigurasi sudah ada di ${globalConfigPath()} — tidak ditimpa.`);
    console.log("Edit file itu langsung bila ingin mengubah penyedia, model, atau anggaran.");
  }
  return 0;
}

interface OpsiAsk {
  pertanyaan: string;
  files: string[];
  dirs: string[];
}

function uraiArgAsk(args: string[]): OpsiAsk | { error: string } {
  const files: string[] = [];
  const dirs: string[] = [];
  const sisa: string[] = [];
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
    } else {
      sisa.push(a);
    }
  }
  const pertanyaan = sisa.join(" ").trim();
  if (!pertanyaan) return { error: "Pertanyaan kosong. Contoh: vibekit ask \"apa itu API?\"" };
  return { pertanyaan, files, dirs };
}

function tampilkanHasil(hasil: HasilTanya): number {
  if (hasil.ok) {
    console.log(hasil.jawaban);
    const sumber = hasil.tokenSumber === "usage" ? "dari usage API" : "estimasi";
    console.log(
      `\n— dijawab oleh ${hasil.provider.nama} (${hasil.provider.model}) • ${formatAngka(hasil.tokenTerpakai)} token (${sumber})`
    );
    for (const c of hasil.catatan) {
      console.error(`[vibekit] dilewati ${c.nama}: ${c.alasan}`);
    }
    return 0;
  }
  console.error(hasil.pesan);
  return 1;
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

  const hasil = await tanyaRouter({
    config,
    messages: [{ role: "user", content: isiUser }],
    lokasiState: statePath(),
  });
  return tampilkanHasil(hasil);
}

async function perintahChat(): Promise<number> {
  let config: VibekitConfig;
  try {
    config = muatConfig().config;
  } catch (e) {
    console.error(`[vibekit] ${(e as Error).message}`);
    return 2;
  }
  console.log("VibeKit chat — ketik pertanyaan, /keluar untuk berhenti.");
  const riwayat: ChatMessage[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "kamu> " });
  let rlDitutup = false;
  rl.on("close", () => {
    rlDitutup = true;
  });
  const promptAman = () => {
    if (!rlDitutup) {
      try {
        rl.prompt();
      } catch {
        /* readline sudah tertutup (EOF) — abaikan */
      }
    }
  };
  promptAman();
  for await (const barisMentah of rl) {
    const baris = barisMentah.trim();
    if (baris === "/keluar" || baris === "/exit") break;
    if (!baris) {
      promptAman();
      continue;
    }
    riwayat.push({ role: "user", content: baris });

    // Jaga riwayat: buang giliran tertua sampai total token riwayat masuk akal.
    while (
      riwayat.length > 2 &&
      hitungToken(riwayat.map((m) => m.content).join("\n")) > BATAS_TOKEN_RIWAYAT
    ) {
      riwayat.splice(0, 2);
    }

    const hasil = await tanyaRouter({
      config,
      messages: [...riwayat],
      lokasiState: statePath(),
    });
    if (hasil.ok) {
      riwayat.push({ role: "assistant", content: hasil.jawaban });
      console.log(`\nvibekit (${hasil.provider.nama})> ${hasil.jawaban}\n`);
    } else {
      riwayat.pop(); // pertanyaan yang gagal tidak disimpan sebagai giliran selesai
      console.error(`\n${hasil.pesan}\n`);
    }
    promptAman();
  }
  rl.close();
  return 0;
}

async function perintahDo(args: string[]): Promise<number> {
  const tugas = args.join(" ").trim();
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
  console.log("Tool baca berjalan langsung; tulis/edit file dan jalankan perintah meminta persetujuanmu satu per satu.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const konfirmasi = (deskripsi: string): Promise<boolean> =>
    new Promise((resolve) => {
      console.log(`\n[vibekit] Usulan aksi:\n${deskripsi}`);
      rl.question("Jalankan? (y/N) ", (jawaban) => {
        const j = jawaban.trim().toLowerCase();
        resolve(j === "y" || j === "ya");
      });
    });

  try {
    const hasil = await jalankanAgent({
      config,
      tugas,
      lokasiState: statePath(),
      cwd,
      konfirmasi,
      jejak: (pesan) => console.error(`[vibekit] ${pesan}`),
    });
    for (const c of hasil.catatan) {
      console.error(`[vibekit] dilewati ${c.nama}: ${c.alasan}`);
    }
    console.log(`\n— ringkasan agent (${hasil.jumlahLangkah} langkah) —`);
    console.log(hasil.ringkasan);
    return hasil.ok ? 0 : 1;
  } finally {
    rl.close();
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
      return perintahChat();
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
