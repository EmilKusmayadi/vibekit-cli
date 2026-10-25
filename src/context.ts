import fs from "node:fs";
import path from "node:path";
import { hitungToken } from "./token.js";

const EKSTENSI_BINER = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".class",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".mp3", ".mp4", ".wav", ".mov", ".avi", ".mkv",
  ".woff", ".woff2", ".ttf", ".eot", ".wasm",
]);

const DIR_LEWATI = new Set(["node_modules", ".git", "dist", ".vibekit", ".next", "coverage"]);
const UKURAN_MAKS_FILE = 256 * 1024; // 256 KB — di atas ini dianggap raksasa, dilewati
const CAP_TOKEN_KONTEKS = 16_000;

function terlihatBiner(lokasi: string, buffer: Buffer): boolean {
  if (EKSTENSI_BINER.has(path.extname(lokasi).toLowerCase())) return true;
  const sampel = buffer.subarray(0, 4096);
  return sampel.includes(0);
}

/** Pangkas ringan: buang baris komentar penuh & rapatkan baris kosong berlebih. */
export function pangkasTeks(teks: string): string {
  const baris = teks.split("\n");
  const hasil: string[] = [];
  let kosongBeruntun = 0;
  for (const mentah of baris) {
    const barisRapi = mentah.replace(/\s+$/, "");
    const trim = barisRapi.trim();
    const komentarPenuh =
      (trim.startsWith("//") && !trim.startsWith("///")) ||
      (trim.startsWith("#") && !trim.startsWith("#!") && trim.length > 1) ||
      (trim.startsWith("/*") && trim.endsWith("*/") && trim.length > 3) ||
      trim === "/*" || trim === "*/" || (trim.startsWith("* ") && trim.length > 2);
    if (komentarPenuh) continue;
    if (trim === "") {
      kosongBeruntun++;
      if (kosongBeruntun > 1) continue;
    } else {
      kosongBeruntun = 0;
    }
    hasil.push(barisRapi);
  }
  return hasil.join("\n").trim();
}

export interface HasilKonteks {
  teks: string;
  jumlahFile: number;
  tokenMentah: number;
  tokenTerseleksi: number;
  dilewati: string[];
}

function kumpulkanFile(targets: string[]): { file: string[]; dilewati: string[] } {
  const file: string[] = [];
  const dilewati: string[] = [];
  const kunjungi = (lokasi: string) => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(lokasi);
    } catch {
      dilewati.push(`${lokasi} (tidak ditemukan)`);
      return;
    }
    if (stat.isDirectory()) {
      const nama = path.basename(lokasi);
      if (DIR_LEWATI.has(nama)) {
        dilewati.push(`${lokasi} (folder dilewati)`);
        return;
      }
      for (const entri of fs.readdirSync(lokasi).sort()) kunjungi(path.join(lokasi, entri));
    } else if (stat.isFile()) {
      file.push(lokasi);
    }
  };
  for (const t of targets) kunjungi(t);
  return { file, dilewati };
}

/** Bangun teks konteks dari daftar file/folder, dengan seleksi & pemangkasan hemat token. */
export function bangunKonteks(targets: string[], capToken: number = CAP_TOKEN_KONTEKS): HasilKonteks {
  const { file, dilewati } = kumpulkanFile(targets);
  interface Berkas { lokasi: string; mentah: string; bersih: string; tokenMentah: number; tokenBersih: number }
  const berkas: Berkas[] = [];

  for (const lokasi of file) {
    const stat = fs.statSync(lokasi);
    if (stat.size > UKURAN_MAKS_FILE) {
      dilewati.push(`${lokasi} (terlalu besar: ${Math.round(stat.size / 1024)} KB)`);
      continue;
    }
    const buffer = fs.readFileSync(lokasi);
    if (terlihatBiner(lokasi, buffer)) {
      dilewati.push(`${lokasi} (biner)`);
      continue;
    }
    const mentah = buffer.toString("utf8");
    const bersih = pangkasTeks(mentah);
    berkas.push({ lokasi, mentah, bersih, tokenMentah: hitungToken(mentah), tokenBersih: hitungToken(bersih) });
  }

  let tokenMentah = berkas.reduce((a, b) => a + b.tokenMentah, 0);
  let tokenTerseleksi = berkas.reduce((a, b) => a + b.tokenBersih, 0);

  // Bila masih melewati cap: potong isi berkas terbesar berulang kali sampai muat.
  let pengaman = 0;
  while (tokenTerseleksi > capToken && berkas.length > 0 && pengaman++ < 200) {
    berkas.sort((a, b) => b.tokenBersih - a.tokenBersih);
    const terbesar = berkas[0];
    if (terbesar.tokenBersih <= 40) break;
    const potong = Math.floor(terbesar.bersih.length / 2);
    terbesar.bersih = terbesar.bersih.slice(0, potong) + "\n…[dipotong demi anggaran token]";
    terbesar.tokenBersih = hitungToken(terbesar.bersih);
    tokenTerseleksi = berkas.reduce((a, b) => a + b.tokenBersih, 0);
  }

  const teks = berkas
    .map((b) => `### File: ${b.lokasi}\n\`\`\`\n${b.bersih}\n\`\`\``)
    .join("\n\n");
  tokenMentah = berkas.reduce((a, b) => a + b.tokenMentah, 0);
  tokenTerseleksi = berkas.reduce((a, b) => a + b.tokenBersih, 0);

  return { teks, jumlahFile: berkas.length, tokenMentah, tokenTerseleksi, dilewati };
}
