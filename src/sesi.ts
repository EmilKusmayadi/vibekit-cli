import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./types.js";

/**
 * Sesi chat tersimpan: satu file JSON per sesi di `<dir config>/sesi/`,
 * berisi riwayat internal chat APA ADANYA — termasuk pesan assistant mentah
 * dengan tool_calls dan `extra_content` (thought_signature Gemini) — agar
 * sesi yang dilanjutkan (`vibekit chat --lanjut`) tetap sah dikirim ke API.
 * Penanda `terakhir.json` di folder yang sama menunjuk sesi paling akhir.
 */
export interface SesiChat {
  id: string;
  /** ISO timestamp pembuatan sesi. */
  dibuat: string;
  /** ISO timestamp penyimpanan terakhir. */
  diperbarui: string;
  pesan: ChatMessage[];
}

export interface RingkasanSesi {
  id: string;
  dibuat: string;
  diperbarui: string;
  jumlahPesan: number;
  /** Potongan pesan pengguna pertama (±60 karakter), untuk daftar sesi. */
  cuplikan: string;
}

export function folderSesi(dirConfig: string): string {
  return path.join(dirConfig, "sesi");
}

function lokasiSesi(dirSesi: string, id: string): string {
  return path.join(dirSesi, `${id}.json`);
}

function lokasiPenanda(dirSesi: string): string {
  return path.join(dirSesi, "terakhir.json");
}

/** Buat id sesi baru dari waktu saat ini, mis. "sesi-2026-10-26T00-10-22". */
export function buatIdSesi(sekarang: Date = new Date()): string {
  const dasar = "sesi-" + sekarang.toISOString().replace(/[:.]/g, "-").replace(/-\d+Z$/, "");
  return dasar;
}

/** Simpan sesi ke disk (atomik via file sementara) dan perbarui penanda sesi terakhir. */
export function simpanSesi(dirSesi: string, sesi: SesiChat): void {
  fs.mkdirSync(dirSesi, { recursive: true });
  const lokasi = lokasiSesi(dirSesi, sesi.id);
  const sementara = lokasi + ".tmp";
  fs.writeFileSync(sementara, JSON.stringify(sesi, null, 2) + "\n", "utf8");
  fs.renameSync(sementara, lokasi);
  fs.writeFileSync(
    lokasiPenanda(dirSesi),
    JSON.stringify({ id: sesi.id, diperbarui: sesi.diperbarui }, null, 2) + "\n",
    "utf8"
  );
}

function bacaSesiMentah(lokasi: string): SesiChat | null {
  try {
    const data = JSON.parse(fs.readFileSync(lokasi, "utf8")) as SesiChat;
    if (data && typeof data.id === "string" && Array.isArray(data.pesan)) return data;
  } catch {
    /* file rusak/tidak ada → dianggap tidak ada sesi */
  }
  return null;
}

/** Muat sesi yang ditunjuk penanda terakhir; null bila belum ada / rusak. */
export function muatSesiTerakhir(dirSesi: string): SesiChat | null {
  try {
    const penanda = JSON.parse(fs.readFileSync(lokasiPenanda(dirSesi), "utf8")) as { id?: unknown };
    if (typeof penanda.id !== "string") return null;
    return bacaSesiMentah(lokasiSesi(dirSesi, penanda.id));
  } catch {
    return null;
  }
}

/** Daftar semua sesi tersimpan, terbaru (menurut `diperbarui`) lebih dulu. */
export function daftarSesi(dirSesi: string): RingkasanSesi[] {
  let namaFile: string[];
  try {
    namaFile = fs.readdirSync(dirSesi);
  } catch {
    return [];
  }
  const hasil: RingkasanSesi[] = [];
  for (const nama of namaFile) {
    if (!nama.endsWith(".json") || nama === "terakhir.json") continue;
    const sesi = bacaSesiMentah(path.join(dirSesi, nama));
    if (!sesi) continue;
    const pesanUserPertama = sesi.pesan.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.trim() !== ""
    );
    const mentah = (pesanUserPertama?.content ?? "").replace(/\s+/g, " ").trim();
    hasil.push({
      id: sesi.id,
      dibuat: sesi.dibuat,
      diperbarui: sesi.diperbarui,
      jumlahPesan: sesi.pesan.length,
      cuplikan: mentah.length > 60 ? mentah.slice(0, 60) + "…" : mentah,
    });
  }
  hasil.sort((a, b) => (a.diperbarui < b.diperbarui ? 1 : a.diperbarui > b.diperbarui ? -1 : 0));
  return hasil;
}
