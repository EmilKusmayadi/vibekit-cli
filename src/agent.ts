import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { tanyaRouter, type CatatanPenyedia } from "./router.js";
import type { ChatMessage, ToolCall, ToolDefinition, VibekitConfig } from "./types.js";

/** Callback konfirmasi pengguna: true = aksi boleh dijalankan. */
export type Konfirmasi = (deskripsi: string) => Promise<boolean>;

/** Hasil tool dipangkas sampai ±karakter ini sebelum dikirim balik ke model (hemat token). */
const BATAS_HASIL_TOOL = 4000;
/** Batas waktu jalankan_perintah. */
const TIMEOUT_PERINTAH_MS = 60_000;
/** Batas langkah agent bawaan. */
export const MAKS_LANGKAH_BAWAAN = 12;

const SKEMA_PATH = {
  type: "string",
  description: "Path relatif terhadap folder kerja (cwd). Tidak boleh keluar dari folder kerja.",
} as const;

/** Definisi 5 tool mode agent (format function calling OpenAI, skema ketat). */
export const DEFINISI_TOOL: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "daftar_file",
      description: "Daftar isi sebuah folder di dalam folder kerja. Baca-saja, tanpa konfirmasi.",
      parameters: {
        type: "object",
        properties: {
          path: { ...SKEMA_PATH, description: "Path folder relatif; kosong atau '.' berarti folder kerja itu sendiri." },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "baca_file",
      description: "Baca isi sebuah file teks di dalam folder kerja. Baca-saja, tanpa konfirmasi.",
      parameters: {
        type: "object",
        properties: { path: SKEMA_PATH },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tulis_file",
      description:
        "Buat file baru atau timpa file yang ada dengan konten yang diberikan (folder induk dibuat bila perlu). Selalu meminta konfirmasi pengguna.",
      parameters: {
        type: "object",
        properties: {
          path: SKEMA_PATH,
          konten: { type: "string", description: "Seluruh isi file yang akan ditulis." },
        },
        required: ["path", "konten"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Ganti kemunculan PERTAMA teksLama dengan teksBaru di dalam file. Error bila teksLama tidak ditemukan. Selalu meminta konfirmasi pengguna.",
      parameters: {
        type: "object",
        properties: {
          path: SKEMA_PATH,
          teksLama: { type: "string", description: "Teks persis yang dicari (harus muncul minimal sekali)." },
          teksBaru: { type: "string", description: "Teks pengganti." },
        },
        required: ["path", "teksLama", "teksBaru"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "jalankan_perintah",
      description:
        "Jalankan sebuah perintah shell di folder kerja (timeout 60 detik) dan kembalikan stdout+stderr. Selalu meminta konfirmasi pengguna.",
      parameters: {
        type: "object",
        properties: {
          perintah: { type: "string", description: "Perintah shell lengkap yang akan dijalankan di folder kerja." },
        },
        required: ["perintah"],
        additionalProperties: false,
      },
    },
  },
];

const SYSTEM_PROMPT_AGENT = [
  "Kamu adalah agent pelaksana tugas VibeKit yang bekerja di dalam SATU folder kerja pengguna.",
  "Kerjakan tugas langkah demi langkah memakai tool yang tersedia: daftar_file, baca_file, tulis_file, edit_file, jalankan_perintah.",
  "Semua path bersifat relatif terhadap folder kerja; jangan pernah mencoba mengakses apa pun di luar folder itu.",
  "Aksi tulis_file, edit_file, dan jalankan_perintah selalu meminta persetujuan pengguna dulu; bila pengguna menolak, jangan memaksa dan jangan mengulang aksi yang sama — sesuaikan rencana atau akhiri tugas.",
  "Jangan mengarang isi file: gunakan daftar_file/baca_file dulu bila perlu mengetahui isi folder/file.",
  "Bila tugas selesai (atau tidak bisa dilanjutkan), balas TANPA memanggil tool, berisi ringkasan akhir yang singkat dalam poin-poin penting: apa yang dilakukan dan hasilnya.",
].join(" ");

/**
 * Resolve path masukan terhadap cwd. Mengembalikan null bila hasil resolve
 * keluar dari cwd (path traversal) — kunci keamanan mode agent.
 */
function resolusiAman(cwd: string, masukan: string): string | null {
  const dasar = path.resolve(cwd);
  const tujuan = path.resolve(dasar, masukan);
  if (tujuan === dasar) return tujuan;
  return tujuan.startsWith(dasar + path.sep) ? tujuan : null;
}

function pathRelatif(cwd: string, tujuan: string): string {
  const rel = path.relative(path.resolve(cwd), tujuan);
  return rel === "" ? "." : rel;
}

function potong(teks: string, maks: number): string {
  return teks.length > maks ? teks.slice(0, maks) + "…" : teks;
}

/** Pangkas hasil tool sampai ±BATAS_HASIL_TOOL karakter sebelum dikirim ke model. */
function potongHasilTool(teks: string): string {
  if (teks.length <= BATAS_HASIL_TOOL) return teks;
  return teks.slice(0, BATAS_HASIL_TOOL) + `\n…(hasil dipotong demi hemat token; total ${teks.length} karakter)`;
}

/** Ringkasan argumen satu baris untuk jejak langkah yang dicetak CLI. */
function argumenRingkas(nama: string, arg: Record<string, unknown>): string {
  switch (nama) {
    case "jalankan_perintah":
      return potong(String(arg.perintah ?? ""), 80);
    case "tulis_file":
    case "edit_file":
    case "baca_file":
    case "daftar_file":
      return String(arg.path ?? ".");
    default:
      return potong(JSON.stringify(arg), 80);
  }
}

interface KonteksEksekusi {
  cwd: string;
  konfirmasi: Konfirmasi;
}

/**
 * Jalankan satu panggilan tool. Selalu mengembalikan teks hasil untuk model
 * (tidak pernah throw): keberhasilan diawali "OK:", kegagalan "ERROR:",
 * penolakan pengguna "DITOLAK:".
 */
export async function eksekusiTool(panggilan: ToolCall, konteks: KonteksEksekusi): Promise<string> {
  const nama = panggilan.function.name;
  let arg: Record<string, unknown>;
  try {
    arg = JSON.parse(panggilan.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return `ERROR: argumen untuk tool ${nama} bukan JSON yang valid.`;
  }
  const { cwd, konfirmasi } = konteks;
  const ambilPath = (mentah: unknown): { tujuan: string; rel: string } | { error: string } => {
    const masukan = typeof mentah === "string" && mentah.trim() !== "" ? mentah : ".";
    const tujuan = resolusiAman(cwd, masukan);
    if (!tujuan) {
      return { error: `ERROR: path "${masukan}" berada di luar folder kerja — akses ditolak demi keamanan.` };
    }
    return { tujuan, rel: pathRelatif(cwd, tujuan) };
  };

  try {
    switch (nama) {
      case "daftar_file": {
        const p = ambilPath(arg.path);
        if ("error" in p) return p.error;
        const entri = await fs.readdir(p.tujuan, { withFileTypes: true });
        if (entri.length === 0) return `OK: folder ${p.rel} kosong.`;
        const baris = entri
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return `OK: isi folder ${p.rel}:\n${baris.join("\n")}`;
      }
      case "baca_file": {
        const p = ambilPath(arg.path);
        if ("error" in p) return p.error;
        const isi = await fs.readFile(p.tujuan, "utf8");
        return `OK: isi file ${p.rel}:\n${isi}`;
      }
      case "tulis_file": {
        const p = ambilPath(arg.path);
        if ("error" in p) return p.error;
        const konten = typeof arg.konten === "string" ? arg.konten : "";
        const deskripsi =
          `tulis_file → ${p.rel} (${konten.length} karakter)\n` +
          `Pratinjau konten:\n${potong(konten, 300)}`;
        if (!(await konfirmasi(deskripsi))) {
          return `DITOLAK: pengguna menolak aksi tulis_file ke ${p.rel}. File tidak ditulis. Jangan mengulang aksi yang sama; sesuaikan rencana atau akhiri dengan ringkasan.`;
        }
        await fs.mkdir(path.dirname(p.tujuan), { recursive: true });
        await fs.writeFile(p.tujuan, konten, "utf8");
        return `OK: file ${p.rel} ditulis (${konten.length} karakter).`;
      }
      case "edit_file": {
        const p = ambilPath(arg.path);
        if ("error" in p) return p.error;
        const teksLama = typeof arg.teksLama === "string" ? arg.teksLama : "";
        const teksBaru = typeof arg.teksBaru === "string" ? arg.teksBaru : "";
        const isi = await fs.readFile(p.tujuan, "utf8");
        const idx = isi.indexOf(teksLama);
        if (idx < 0) {
          return `ERROR: teksLama tidak ditemukan di ${p.rel}; tidak ada yang diubah. Baca file lagi dan salin teks persisnya.`;
        }
        const deskripsi =
          `edit_file → ${p.rel}\n` +
          `Teks lama: ${potong(teksLama, 150)}\n` +
          `Teks baru: ${potong(teksBaru, 150)}`;
        if (!(await konfirmasi(deskripsi))) {
          return `DITOLAK: pengguna menolak aksi edit_file di ${p.rel}. File tidak diubah. Jangan mengulang aksi yang sama; sesuaikan rencana atau akhiri dengan ringkasan.`;
        }
        const baru = isi.slice(0, idx) + teksBaru + isi.slice(idx + teksLama.length);
        await fs.writeFile(p.tujuan, baru, "utf8");
        return `OK: ${p.rel} diubah (kemunculan pertama teksLama diganti teksBaru).`;
      }
      case "jalankan_perintah": {
        const perintah = typeof arg.perintah === "string" ? arg.perintah.trim() : "";
        if (!perintah) return "ERROR: argumen perintah kosong.";
        const deskripsi = `jalankan_perintah → ${perintah}`;
        if (!(await konfirmasi(deskripsi))) {
          return `DITOLAK: pengguna menolak menjalankan perintah "${perintah}". Perintah tidak dijalankan. Jangan mengulang aksi yang sama; sesuaikan rencana atau akhiri dengan ringkasan.`;
        }
        const hasil = await new Promise<{ kode: number | null; stdout: string; stderr: string; timeout: boolean }>(
          (resolve) => {
            exec(
              perintah,
              { cwd: path.resolve(cwd), timeout: TIMEOUT_PERINTAH_MS, maxBuffer: 4 * 1024 * 1024 },
              (err, stdout, stderr) => {
                if (err) {
                  const e = err as unknown as { code?: unknown; killed?: boolean };
                  resolve({
                    kode: typeof e.code === "number" ? e.code : null,
                    stdout: String(stdout ?? ""),
                    stderr: String(stderr ?? ""),
                    timeout: e.killed === true,
                  });
                } else {
                  resolve({ kode: 0, stdout: String(stdout), stderr: String(stderr), timeout: false });
                }
              }
            );
          }
        );
        const bagian = [`kode keluar: ${hasil.kode ?? "?"}${hasil.timeout ? " (timeout 60 detik, perintah dihentikan)" : ""}`];
        if (hasil.stdout.trim()) bagian.push(`stdout:\n${hasil.stdout.trimEnd()}`);
        if (hasil.stderr.trim()) bagian.push(`stderr:\n${hasil.stderr.trimEnd()}`);
        return (hasil.kode === 0 ? "OK: " : "ERROR: ") + bagian.join("\n");
      }
      default:
        return `ERROR: tool tidak dikenal: ${nama}. Tool yang tersedia: daftar_file, baca_file, tulis_file, edit_file, jalankan_perintah.`;
    }
  } catch (e) {
    return `ERROR: ${(e as Error).message}`;
  }
}

export interface OpsiAgent {
  config: VibekitConfig;
  /** Tugas dalam bahasa alami dari pengguna. */
  tugas: string;
  lokasiState: string;
  /** Folder kerja: satu-satunya wilayah yang boleh disentuh tool. */
  cwd: string;
  konfirmasi: Konfirmasi;
  fetchImpl?: typeof fetch;
  /** Batas jumlah panggilan model (bawaan 12). */
  maksLangkah?: number;
  /** Callback jejak langkah (untuk dicetak CLI secara langsung). */
  jejak?: (pesan: string) => void;
}

export interface HasilAgent {
  ok: boolean;
  ringkasan: string;
  jumlahLangkah: number;
  catatan: CatatanPenyedia[];
}

/**
 * Loop mode agent: panggil router (dengan tools) → jalankan tool_calls yang
 * diminta model lewat eksekutor aman → kirim hasil tool balik → ulangi sampai
 * model membalas teks tanpa tool_calls (ringkasan akhir) atau langkah habis.
 */
export async function jalankanAgent(opsi: OpsiAgent): Promise<HasilAgent> {
  const maksLangkah = opsi.maksLangkah ?? MAKS_LANGKAH_BAWAAN;
  const catatan: CatatanPenyedia[] = [];
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT_AGENT },
    { role: "user", content: opsi.tugas },
  ];

  let langkah = 0;
  while (langkah < maksLangkah) {
    langkah++;
    const hasil = await tanyaRouter({
      config: opsi.config,
      messages,
      lokasiState: opsi.lokasiState,
      fetchImpl: opsi.fetchImpl,
      tools: DEFINISI_TOOL,
    });
    catatan.push(...hasil.catatan);

    if (!hasil.ok) {
      return { ok: false, ringkasan: hasil.pesan, jumlahLangkah: langkah, catatan };
    }

    const panggilan = hasil.toolCalls ?? [];
    if (panggilan.length === 0) {
      // Balasan teks murni = ringkasan akhir dari model.
      return { ok: true, ringkasan: hasil.jawaban, jumlahLangkah: langkah, catatan };
    }

    if (hasil.pesanMentah && typeof hasil.pesanMentah === "object") {
      // Teruskan pesan assistant persis seperti yang dikirim penyedia. Gemini 3
      // menyisipkan thought_signature di dalam tool_calls (extra_content) dan
      // menolak permintaan berikutnya dengan HTTP 400 bila tanda tangan itu
      // hilang dari riwayat — jadi pesan mentah tidak boleh dibangun ulang.
      messages.push(hasil.pesanMentah as ChatMessage);
    } else {
      messages.push({
        role: "assistant",
        content: hasil.jawaban ? hasil.jawaban : null,
        tool_calls: panggilan,
      });
    }

    for (const p of panggilan) {
      let argRingkas = "";
      try {
        argRingkas = argumenRingkas(p.function.name, JSON.parse(p.function.arguments || "{}"));
      } catch {
        argRingkas = "";
      }
      opsi.jejak?.(`langkah ${langkah}: ${p.function.name}${argRingkas ? ` (${argRingkas})` : ""}`);
      const hasilTool = await eksekusiTool(p, { cwd: opsi.cwd, konfirmasi: opsi.konfirmasi });
      opsi.jejak?.(`  → ${potong(hasilTool.split("\n")[0], 120)}`);
      messages.push({
        role: "tool",
        tool_call_id: p.id,
        name: p.function.name,
        content: potongHasilTool(hasilTool),
      });
    }
  }

  return {
    ok: false,
    ringkasan:
      `Batas langkah tercapai (${maksLangkah} langkah) sebelum tugas selesai. ` +
      "Jalankan lagi perintah yang sama untuk melanjutkan, atau persempit tugasnya.",
    jumlahLangkah: langkah,
    catatan,
  };
}
