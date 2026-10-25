import fs from "node:fs";
import path from "node:path";
import { hitungToken } from "./token.js";

/**
 * Brief proyek (`.vibekit/brief.md`): ringkasan konteks proyek yang padat &
 * faktual, disusun dari pemindaian lokal folder kerja — pohon direktori
 * (maks 3 tingkat), stack dari package.json, potongan README, dan file
 * konfigurasi penting. Brief ditulis sekali lewat `vibekit brief`, lalu
 * dipakai otomatis sebagai konteks tambahan pada ask/chat/do.
 */

const DIR_LEWATI = new Set(["node_modules", ".git", "dist", "build", ".vibekit"]);

const EKSTENSI_BINER = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".svgz",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".class",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".mp3", ".mp4", ".wav", ".mov", ".avi", ".mkv",
  ".woff", ".woff2", ".ttf", ".eot", ".wasm",
]);

/** Peta ekstensi → bahasa, untuk bahasa dominan & daftar ekstensi. */
const BAHASA_DARI_EKSTENSI: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".php": "PHP",
  ".rb": "Ruby",
  ".cs": "C#",
  ".swift": "Swift",
  ".kt": "Kotlin",
  ".dart": "Dart",
  ".vue": "Vue",
  ".svelte": "Svelte",
};

/** Nama paket → label stack yang dikenal, untuk deteksi dari dependencies. */
const LABEL_STACK: Record<string, string> = {
  typescript: "TypeScript",
  react: "React",
  "react-dom": "React",
  next: "Next.js",
  vue: "Vue",
  "@angular/core": "Angular",
  svelte: "Svelte",
  express: "Express",
  fastify: "Fastify",
  "@nestjs/core": "NestJS",
  tailwindcss: "Tailwind CSS",
  prisma: "Prisma",
  "@prisma/client": "Prisma",
  mongoose: "Mongoose",
  pg: "PostgreSQL",
  mysql2: "MySQL",
  vite: "Vite",
  webpack: "Webpack",
  electron: "Electron",
  "react-native": "React Native",
  expo: "Expo",
};

/** File konfigurasi penting yang dideteksi keberadaannya (hanya NAMA yang dicatat). */
const FILE_KONFIGURASI = [
  "tsconfig.json",
  "jsconfig.json",
  ".env.example",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "webpack.config.js",
  "eslint.config.js",
  ".eslintrc.json",
  ".eslintrc.js",
  "prettier.config.js",
  ".prettierrc",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "vercel.json",
  "netlify.toml",
];

interface HasilPindai {
  pohon: string[];
  jumlahFile: number;
  jumlahTerpotong: number;
  perEkstensi: Map<string, number>;
}

function pindaiPohon(akar: string): HasilPindai {
  const pohon: string[] = [];
  const perEkstensi = new Map<string, number>();
  let jumlahFile = 0;
  let jumlahTerpotong = 0;
  const MAKS_BARIS_POHON = 150;

  const kunjungi = (dir: string, kedalaman: number): void => {
    if (kedalaman > 3) return;
    let entri: fs.Dirent[];
    try {
      entri = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entri.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entri) {
      const rel = path.relative(akar, path.join(dir, e.name)).split(path.sep).join("/");
      if (e.isDirectory()) {
        if (DIR_LEWATI.has(e.name)) continue;
        if (pohon.length < MAKS_BARIS_POHON) pohon.push(`${rel}/`);
        else jumlahTerpotong++;
        kunjungi(path.join(dir, e.name), kedalaman + 1);
      } else if (e.isFile()) {
        // File .env asli tidak pernah dicatat (bisa memuat rahasia); hanya
        // .env.example yang boleh muncul sebagai nama file konfigurasi.
        if (e.name.startsWith(".env") && e.name !== ".env.example") continue;
        const ekst = path.extname(e.name).toLowerCase();
        if (EKSTENSI_BINER.has(ekst)) continue;
        jumlahFile++;
        if (ekst) perEkstensi.set(ekst, (perEkstensi.get(ekst) ?? 0) + 1);
        if (pohon.length < MAKS_BARIS_POHON) pohon.push(rel);
        else jumlahTerpotong++;
      }
    }
  };
  kunjungi(akar, 1);
  return { pohon, jumlahFile, jumlahTerpotong, perEkstensi };
}

export interface HasilBrief {
  /** Lokasi file brief yang ditulis. */
  lokasi: string;
  /** Isi markdown brief. */
  isi: string;
  /** Perkiraan token isi brief (tokenizer lokal). */
  token: number;
  jumlahFile: number;
}

/** Pindai folder `cwd`, susun brief markdown, dan tulis ke `<cwd>/.vibekit/brief.md`. */
export function buatBrief(cwd: string): HasilBrief {
  const akar = path.resolve(cwd);
  const pindai = pindaiPohon(akar);
  const baris: string[] = [];

  // package.json: nama, stack, dependencies utama, scripts.
  let pkg: Record<string, unknown> | null = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(akar, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    pkg = null;
  }
  const namaProyek =
    pkg && typeof pkg.name === "string" && pkg.name ? pkg.name : path.basename(akar);
  baris.push(`# Brief Proyek — ${namaProyek}`, "");

  const fakta: string[] = [];
  if (pkg && typeof pkg.version === "string") fakta.push(`Versi paket: ${pkg.version}`);
  fakta.push(`Total file terpindai: ${pindai.jumlahFile}`);

  // Bahasa dominan dari ekstensi berkode terbanyak.
  const perBahasa = new Map<string, number>();
  for (const [ekst, n] of pindai.perEkstensi) {
    const bahasa = BAHASA_DARI_EKSTENSI[ekst];
    if (bahasa) perBahasa.set(bahasa, (perBahasa.get(bahasa) ?? 0) + n);
  }
  const bahasaUrut = [...perBahasa.entries()].sort((a, b) => b[1] - a[1]);
  if (bahasaUrut.length > 0) fakta.push(`Bahasa dominan: ${bahasaUrut[0][0]}`);
  baris.push(...fakta.map((f) => `- ${f}`), "");

  // Stack terdeteksi dari dependencies package.json.
  const semuaDep: Record<string, string> = {};
  if (pkg) {
    for (const kunci of ["dependencies", "devDependencies"] as const) {
      const dep = pkg[kunci];
      if (dep && typeof dep === "object") {
        for (const nama of Object.keys(dep as Record<string, unknown>)) {
          semuaDep[nama] = String((dep as Record<string, unknown>)[nama]);
        }
      }
    }
  }
  const stack = Object.keys(semuaDep)
    .filter((nama) => LABEL_STACK[nama])
    .map((nama) => LABEL_STACK[nama]);
  if (stack.length > 0) {
    baris.push("## Stack", ...[...new Set(stack)].map((s) => `- ${s}`), "");
  }
  const namaDep = Object.keys(semuaDep).sort();
  if (namaDep.length > 0) {
    baris.push("## Dependencies", ...namaDep.slice(0, 30).map((n) => `- ${n}@${semuaDep[n]}`), "");
  }
  const scripts = pkg?.scripts;
  if (scripts && typeof scripts === "object") {
    const entri = Object.entries(scripts as Record<string, unknown>);
    if (entri.length > 0) {
      baris.push(
        "## Scripts (package.json)",
        ...entri.map(([nama, perintah]) => {
          const p = String(perintah);
          return `- ${nama}: ${p.length > 60 ? p.slice(0, 60) + "…" : p}`;
        }),
        ""
      );
    }
  }

  // File konfigurasi penting yang terdeteksi (nama saja).
  const konfigurasi = FILE_KONFIGURASI.filter((nama) => fs.existsSync(path.join(akar, nama)));
  if (konfigurasi.length > 0) {
    baris.push("## File Konfigurasi", ...konfigurasi.map((k) => `- ${k}`), "");
  }

  // Ekstensi terbanyak (10 teratas).
  const ekstUrut = [...pindai.perEkstensi.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (ekstUrut.length > 0) {
    baris.push("## Ekstensi Terbanyak", ...ekstUrut.map(([e, n]) => `- ${e}: ${n} file`), "");
  }

  // Pohon direktori (maks 3 tingkat).
  baris.push("## Struktur Folder (maks 3 tingkat)", ...pindai.pohon.map((p) => `- ${p}`));
  if (pindai.jumlahTerpotong > 0) baris.push(`- … (${pindai.jumlahTerpotong} entri lain tidak ditampilkan)`);
  baris.push("");

  // README: judul + potongan awal ±600 karakter.
  let namaReadme: string | null = null;
  try {
    namaReadme = fs.readdirSync(akar).find((n) => /^readme(\..+)?$/i.test(n)) ?? null;
  } catch {
    namaReadme = null;
  }
  if (namaReadme) {
    try {
      const isiReadme = fs.readFileSync(path.join(akar, namaReadme), "utf8");
      const judul =
        isiReadme
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.startsWith("# "))?.replace(/^#\s+/, "") ??
        isiReadme.split("\n").find((l) => l.trim() !== "")?.trim() ??
        "";
      baris.push("## README (potongan)");
      if (judul) baris.push(`- Judul: ${judul}`);
      const potongan = isiReadme.trim().slice(0, 600);
      baris.push("", potongan + (isiReadme.trim().length > 600 ? "…" : ""), "");
    } catch {
      /* README tidak terbaca: lewati bagian ini */
    }
  }

  const isi = baris.join("\n").trimEnd() + "\n";
  const lokasi = path.join(akar, ".vibekit", "brief.md");
  fs.mkdirSync(path.dirname(lokasi), { recursive: true });
  fs.writeFileSync(lokasi, isi, "utf8");
  return { lokasi, isi, token: hitungToken(isi), jumlahFile: pindai.jumlahFile };
}

/** Batas token brief yang disuntikkan otomatis ke konteks model. */
export const BATAS_TOKEN_BRIEF = 4000;

/** Awalan penanda pesan konteks brief (dipakai untuk menghindari suntikan ganda). */
export const AWALAN_KONTEKS_BRIEF = "Konteks proyek (dari .vibekit/brief.md):";

/**
 * Muat brief proyek dari `<cwd>/.vibekit/brief.md` untuk disuntikkan sebagai
 * konteks model. Mengembalikan null bila brief tidak ada. Isi yang melewati
 * BATAS_TOKEN_BRIEF dipotong dengan penanda yang jelas.
 */
export function muatKonteksBrief(cwd: string): { teks: string; token: number } | null {
  const lokasi = path.join(path.resolve(cwd), ".vibekit", "brief.md");
  let isi: string;
  try {
    isi = fs.readFileSync(lokasi, "utf8");
  } catch {
    return null;
  }
  let token = hitungToken(isi);
  if (token > BATAS_TOKEN_BRIEF) {
    let potong = isi;
    // Potong proporsional lalu rapikan sampai muat (maks beberapa putaran).
    for (let i = 0; i < 6 && hitungToken(potong) > BATAS_TOKEN_BRIEF; i++) {
      const rasio = BATAS_TOKEN_BRIEF / hitungToken(potong);
      potong = potong.slice(0, Math.max(200, Math.floor(potong.length * rasio * 0.95)));
    }
    isi = potong.trimEnd() + "\n\n…[brief dipotong: melebihi batas 4.000 token]";
    token = hitungToken(isi);
  }
  return { teks: `${AWALAN_KONTEKS_BRIEF}\n\n${isi}`, token };
}
