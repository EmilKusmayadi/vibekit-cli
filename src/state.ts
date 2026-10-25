import fs from "node:fs";
import path from "node:path";

export interface ProviderState {
  /** Tanggal lokal (YYYY-MM-DD) yang menjadi kunci reset harian. */
  tanggal: string;
  totalToken: number;
  cooldownUntil: string | null;
  alasanTerakhir: string | null;
}

export interface StateFile {
  providers: Record<string, ProviderState>;
}

/** Tanggal lokal pengguna dalam format YYYY-MM-DD. */
export function tanggalLokal(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Timestamp akhir hari lokal (23:59:59.999) — cooldown untuk kuota habis. */
export function akhirHariIni(d: Date = new Date()): Date {
  const akhir = new Date(d);
  akhir.setHours(23, 59, 59, 999);
  return akhir;
}

export function muatState(lokasi: string): StateFile {
  try {
    if (fs.existsSync(lokasi)) {
      const mentah = JSON.parse(fs.readFileSync(lokasi, "utf8")) as StateFile;
      if (mentah && typeof mentah === "object" && mentah.providers) return mentah;
    }
  } catch {
    /* state rusak → mulai dari kosong */
  }
  return { providers: {} };
}

export function simpanState(lokasi: string, state: StateFile): void {
  fs.mkdirSync(path.dirname(lokasi), { recursive: true });
  const sementara = lokasi + ".tmp";
  fs.writeFileSync(sementara, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(sementara, lokasi);
}

/**
 * Ambil state penyedia untuk hari ini. Bila entri berasal dari hari lain,
 * hitungan token direset (cooldown akhir-hari otomatis kedaluwarsa).
 */
export function statePenyedia(state: StateFile, nama: string, sekarang: Date = new Date()): ProviderState {
  const hariIni = tanggalLokal(sekarang);
  let entri = state.providers[nama];
  if (!entri || entri.tanggal !== hariIni) {
    entri = { tanggal: hariIni, totalToken: 0, cooldownUntil: null, alasanTerakhir: null };
    state.providers[nama] = entri;
  }
  return entri;
}

export function sedangCooldown(entri: ProviderState, sekarang: Date = new Date()): boolean {
  if (!entri.cooldownUntil) return false;
  return new Date(entri.cooldownUntil).getTime() > sekarang.getTime();
}

export function formatJam(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
