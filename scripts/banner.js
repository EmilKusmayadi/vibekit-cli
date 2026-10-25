// Banner CHISPEAR — tampil otomatis setelah package berhasil terpasang
// (npm postinstall). Tanpa dependensi; hormati NO_COLOR.
// Salinan mandiri dari seni di src/banner.ts (skrip ini tidak boleh bergantung
// pada dist/ karena postinstall juga berjalan sebelum build di repo clone) —
// jaga keduanya tetap sinkron.
const GLIF = {
  C: [" █████ ", "██   ██", "██     ", "██     ", "██   ██", " █████ "],
  H: ["██   ██", "██   ██", "███████", "██   ██", "██   ██", "██   ██"],
  I: ["███", " █ ", " █ ", " █ ", " █ ", "███"],
  S: ["███████", "██     ", "██████ ", "     ██", "     ██", "██████ "],
  P: ["██████ ", "██   ██", "██████ ", "██     ", "██     ", "██     "],
  E: ["███████", "██     ", "█████  ", "█████  ", "██     ", "███████"],
  A: [" █████ ", "██   ██", "███████", "██   ██", "██   ██", "██   ██"],
  R: ["██████ ", "██   ██", "██████ ", "██  ██ ", "██   ██", "██   ██"],
};

const kata = "CHISPEAR";
const baris = ["", "", "", "", "", ""];
for (const huruf of kata) {
  const g = GLIF[huruf];
  if (!g) continue;
  for (let i = 0; i < 6; i++) baris[i] += (baris[i] ? "  " : "") + g[i];
}

const pakaiWarna = !process.env.NO_COLOR;
const HIJAU = pakaiWarna ? "\x1b[1;92m" : "";
const RESET = pakaiWarna ? "\x1b[0m" : "";

console.log("");
for (const b of baris) console.log(HIJAU + b + RESET);
console.log("");
console.log(HIJAU + "  VibeKit CLI terpasang — router AI hemat tokenmu siap dipakai." + RESET);
console.log("  Mulai dengan: vibekit init   •   Bantuan: vibekit --help");
console.log("");
