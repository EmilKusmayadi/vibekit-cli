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
  /**
   * Pemakaian token per tanggal lokal → per penyedia (sejak v0.6.0, untuk
   * laporan `vibekit hemat`). State lama tanpa field ini tetap terbaca;
   * laporan memakai totalToken harian dari `providers` sebagai cadangan
   * untuk tanggal yang belum tercatat di sini.
   */
  pemakaianHarian?: Record<string, Record<string, number>>;
  /**
   * Token yang dibuang kompaksi riwayat chat per tanggal lokal (sejak
   * v0.6.0). Ini satu-satunya angka penghematan yang benar-benar DIUKUR;
   * penghematan dari gaya jawaban & konteks terseleksi bersifat desain.
   */
  hematKompaksi?: Record<string, number>;
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

/** Jumlah hari riwayat pemakaian/hemat yang dipertahankan di state. */
const HARI_RIWAYAT = 30;

function pangkasRiwayatTanggal(peta: Record<string, unknown>, sekarang: Date): void {
  const tanggal = Object.keys(peta).sort();
  const batas = tanggalLokal(new Date(sekarang.getTime() - (HARI_RIWAYAT - 1) * 86_400_000));
  for (const t of tanggal) {
    if (t < batas) delete peta[t];
  }
}

/** Catat pemakaian token satu penyedia ke peta harian (dipakai laporan `vibekit hemat`). */
export function catatPemakaianHarian(
  state: StateFile,
  nama: string,
  token: number,
  sekarang: Date = new Date()
): void {
  if (token <= 0) return;
  if (!state.pemakaianHarian) state.pemakaianHarian = {};
  const tgl = tanggalLokal(sekarang);
  const perProvider = (state.pemakaianHarian[tgl] ??= {});
  perProvider[nama] = (perProvider[nama] ?? 0) + token;
  pangkasRiwayatTanggal(state.pemakaianHarian, sekarang);
}

/** Tambahkan token yang dibuang kompaksi riwayat ke penghitung hemat hari ini, lalu simpan state. */
export function catatHematKompaksi(lokasi: string, token: number, sekarang: Date = new Date()): void {
  if (token <= 0) return;
  const state = muatState(lokasi);
  if (!state.hematKompaksi) state.hematKompaksi = {};
  const tgl = tanggalLokal(sekarang);
  state.hematKompaksi[tgl] = (state.hematKompaksi[tgl] ?? 0) + token;
  pangkasRiwayatTanggal(state.hematKompaksi, sekarang);
  simpanState(lokasi, state);
}

/** Daftar `n` tanggal lokal terakhir, terbaru lebih dulu (hari ini pertama). */
export function tanggalTerakhir(n: number, sekarang: Date = new Date()): string[] {
  const hasil: string[] = [];
  for (let i = 0; i < n; i++) {
    hasil.push(tanggalLokal(new Date(sekarang.getTime() - i * 86_400_000)));
  }
  return hasil;
}

/**
 * Pemakaian token pada satu tanggal, per penyedia. Sumber utama adalah
 * `pemakaianHarian`; untuk tanggal yang belum tercatat di sana (state lama),
 * dipakai totalToken harian dari entri `providers` sebagai cadangan.
 */
export function pemakaianPada(state: StateFile, tanggal: string): Record<string, number> {
  const tercatat = state.pemakaianHarian?.[tanggal];
  if (tercatat) return { ...tercatat };
  const cadangan: Record<string, number> = {};
  for (const [nama, entri] of Object.entries(state.providers)) {
    if (entri.tanggal === tanggal && entri.totalToken > 0) cadangan[nama] = entri.totalToken;
  }
  return cadangan;
}

export function sedangCooldown(entri: ProviderState, sekarang: Date = new Date()): boolean {
  if (!entri.cooldownUntil) return false;
  return new Date(entri.cooldownUntil).getTime() > sekarang.getTime();
}

/**
 * Susun teks laporan `vibekit hemat` dari state: pemakaian hari ini dan 7
 * hari terakhir per penyedia, plus token yang DIUKUR terbuang oleh kompaksi
 * riwayat. Angka penghematan lain (gaya jawaban, konteks terseleksi)
 * sengaja tidak diangkakan — dinyatakan sebagai catatan kejujuran.
 */
export function bangunLaporanHemat(state: StateFile, sekarang: Date = new Date()): string {
  const fmt = (n: number): string => n.toLocaleString("id-ID");
  const hari = tanggalTerakhir(7, sekarang);
  const hariIni = hari[0];
  const baris: string[] = ["Laporan pemakaian & penghematan token", ""];

  const pakaiHariIni = pemakaianPada(state, hariIni);
  const namaHariIni = Object.keys(pakaiHariIni).sort();
  baris.push(`Hari ini (${hariIni}):`);
  if (namaHariIni.length === 0) {
    baris.push("  (belum ada pemakaian tercatat hari ini)");
  } else {
    let total = 0;
    for (const nama of namaHariIni) {
      baris.push(`  ${nama}: ${fmt(pakaiHariIni[nama])} token`);
      total += pakaiHariIni[nama];
    }
    baris.push(`  Total hari ini: ${fmt(total)} token`);
  }

  baris.push("", "7 hari terakhir:");
  const gabungan = new Map<string, number>();
  let total7 = 0;
  for (const tgl of hari) {
    const pakai = pemakaianPada(state, tgl);
    const totalHari = Object.values(pakai).reduce((a, b) => a + b, 0);
    baris.push(`  ${tgl}: ${fmt(totalHari)} token`);
    total7 += totalHari;
    for (const [nama, token] of Object.entries(pakai)) {
      gabungan.set(nama, (gabungan.get(nama) ?? 0) + token);
    }
  }
  for (const nama of [...gabungan.keys()].sort()) {
    baris.push(`  ${nama} (7 hari): ${fmt(gabungan.get(nama) as number)} token`);
  }
  baris.push(`  Total 7 hari terakhir: ${fmt(total7)} token`);

  const hemat = state.hematKompaksi ?? {};
  const hematHariIni = hemat[hariIni] ?? 0;
  const hematTotal = Object.values(hemat).reduce((a, b) => a + b, 0);
  baris.push(
    "",
    "Token yang dihemat kompaksi riwayat chat (terukur dari isi yang dibuang):",
    `  Hari ini: ${fmt(hematHariIni)} token`,
    `  Total tercatat: ${fmt(hematTotal)} token`,
    "",
    "Catatan: penghematan dari gaya jawaban ringkas dan konteks terseleksi bersifat desain (mencegah token terpakai sejak awal) dan tidak dihitung sebagai angka di laporan ini."
  );
  return baris.join("\n");
}

export function formatJam(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
