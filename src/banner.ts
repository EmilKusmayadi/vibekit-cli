// Banner CHISPEAR hijau besar — ditampilkan saat `vibekit init` pertama kali
// (momen "berhasil terpasang & diatur" yang pasti terlihat pengguna, karena
// keluaran skrip postinstall npm tidak selalu ditampilkan npm).
// CATATAN: scripts/banner.js adalah salinan mandiri dari seni ini untuk
// postinstall — jaga keduanya tetap sinkron.
const GLIF: Record<string, string[]> = {
  C: [" █████ ", "██   ██", "██     ", "██     ", "██   ██", " █████ "],
  H: ["██   ██", "██   ██", "███████", "██   ██", "██   ██", "██   ██"],
  I: ["███", " █ ", " █ ", " █ ", " █ ", "███"],
  S: ["███████", "██     ", "██████ ", "     ██", "     ██", "██████ "],
  P: ["██████ ", "██   ██", "██████ ", "██     ", "██     ", "██     "],
  E: ["███████", "██     ", "█████  ", "█████  ", "██     ", "███████"],
  A: [" █████ ", "██   ██", "███████", "██   ██", "██   ██", "██   ██"],
  R: ["██████ ", "██   ██", "██████ ", "██  ██ ", "██   ██", "██   ██"],
};

/** Teks banner CHISPEAR (hijau terang bila NO_COLOR tidak diset). */
export function teksBanner(): string {
  const baris = ["", "", "", "", "", ""];
  for (const huruf of "CHISPEAR") {
    const g = GLIF[huruf];
    if (!g) continue;
    for (let i = 0; i < 6; i++) baris[i] += (baris[i] ? "  " : "") + g[i];
  }
  const pakaiWarna = !process.env.NO_COLOR;
  const HIJAU = pakaiWarna ? "\x1b[1;92m" : "";
  const RESET = pakaiWarna ? "\x1b[0m" : "";
  return [
    "",
    ...baris.map((b) => HIJAU + b + RESET),
    "",
    HIJAU + "  VibeKit CLI terpasang — router AI hemat tokenmu siap dipakai." + RESET,
    "",
  ].join("\n");
}
