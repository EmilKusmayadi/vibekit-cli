/**
 * Client MCP (Model Context Protocol) — ditulis dari nol di atas JSON-RPC 2.0,
 * tanpa dependency baru. VibeKit berperan sebagai MCP *client*: tool dari
 * server MCP mana pun (lokal lewat stdio, remote lewat Streamable HTTP)
 * digabung ke daftar tool agent dengan nama ter-namespace
 * `mcp__<namaServer>__<namaTool>`.
 *
 * Alur handshake per server: request `initialize` (menawarkan versi protokol
 * di bawah; versi jawaban server diterima apa adanya) → notifikasi
 * `notifications/initialized` → `tools/list`. Pemanggilan tool lewat
 * `tools/call`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerConfig, ToolDefinition } from "./types.js";

export type { McpServerConfig } from "./types.js";

/** Versi protokol MCP yang ditawarkan saat initialize. */
const VERSI_PROTOKOL = "2025-03-26";
/** Samakan dengan "version" di package.json (nama/versi clientInfo handshake). */
const VERSI_KLIEN = "0.7.0";
/** Batas waktu satu request JSON-RPC (kedua transport). */
const TIMEOUT_REQUEST_MS = 60_000;

interface PesanJsonRpc {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface ToolMentah {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Koneksi JSON-RPC ke satu server MCP (abstraksi di atas transport). */
interface KoneksiMcp {
  /** Kirim request dan tunggu result-nya; lempar Error terbaca bila server menjawab error/timeout. */
  minta: (method: string, params?: unknown) => Promise<unknown>;
  /** Kirim notifikasi (tanpa id, tanpa menunggu jawaban bermakna). */
  beriTahu: (method: string, params?: unknown) => Promise<void>;
  /** Putuskan sambungan (bunuh proses anak untuk stdio). */
  tutup: () => Promise<void>;
}

/** Ubah pesan error JSON-RPC menjadi Error yang terbaca manusia. */
function errorDariPesan(pesan: PesanJsonRpc): Error {
  const e = pesan.error;
  return new Error(`error JSON-RPC${e?.code !== undefined ? ` ${e.code}` : ""}: ${e?.message ?? "tanpa pesan"}`);
}

/* ------------------------------------------------------------------ */
/* Transport stdio: proses anak, pesan JSON dipisah newline (NDJSON).  */
/* ------------------------------------------------------------------ */

function buatKoneksiStdio(cfg: McpServerConfig): KoneksiMcp {
  const perintah = cfg.perintah as string;
  const anak: ChildProcessWithoutNullStreams = spawn(perintah, cfg.argumen ?? [], {
    env: { ...process.env, ...(cfg.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // stderr server tidak dipakai protokol; tampung & buang agar pipa tidak penuh.
  anak.stderr.on("data", () => {});

  interface Menunggu {
    resolve: (hasil: unknown) => void;
    reject: (err: Error) => void;
    pengatur: NodeJS.Timeout;
  }
  const menunggu = new Map<number, Menunggu>();
  let idBerikut = 0;
  let sisaBaris = "";
  let ditutup = false;
  let gagalFatal: Error | null = null;

  const gagalkanSemua = (err: Error): void => {
    if (!gagalFatal) gagalFatal = err;
    for (const m of menunggu.values()) {
      clearTimeout(m.pengatur);
      m.reject(gagalFatal);
    }
    menunggu.clear();
  };

  anak.on("error", (e) => {
    gagalkanSemua(new Error(`gagal menjalankan server MCP "${cfg.nama}" (${perintah}): ${e.message}`));
  });
  anak.on("exit", (kode) => {
    if (!ditutup) {
      gagalkanSemua(new Error(`server MCP "${cfg.nama}" berhenti sebelum menjawab (kode keluar ${kode ?? "?"})`));
    }
  });

  anak.stdout.on("data", (potongan: Buffer) => {
    sisaBaris += potongan.toString("utf8");
    let idx: number;
    // Respons bisa terpotong antar-chunk: proses hanya baris yang sudah utuh.
    while ((idx = sisaBaris.indexOf("\n")) >= 0) {
      const baris = sisaBaris.slice(0, idx).trim();
      sisaBaris = sisaBaris.slice(idx + 1);
      if (!baris) continue;
      let pesan: PesanJsonRpc;
      try {
        pesan = JSON.parse(baris) as PesanJsonRpc;
      } catch {
        continue; // baris bukan JSON (mis. log server) — abaikan
      }
      if (pesan.id === undefined) continue; // notifikasi dari server — abaikan
      const idNum = typeof pesan.id === "number" ? pesan.id : Number(pesan.id);
      const m = menunggu.get(idNum);
      if (!m) continue; // respons tak dikenal / permintaan dari server — abaikan
      menunggu.delete(idNum);
      clearTimeout(m.pengatur);
      if (pesan.error) m.reject(errorDariPesan(pesan));
      else m.resolve(pesan.result);
    }
  });

  const tulis = (obj: unknown): void => {
    anak.stdin.write(JSON.stringify(obj) + "\n");
  };

  return {
    minta: (method, params) => {
      if (gagalFatal) return Promise.reject(gagalFatal);
      if (ditutup) return Promise.reject(new Error(`koneksi MCP "${cfg.nama}" sudah ditutup`));
      const id = ++idBerikut;
      return new Promise<unknown>((resolve, reject) => {
        const pengatur = setTimeout(() => {
          menunggu.delete(id);
          reject(new Error(`server MCP "${cfg.nama}" tidak menjawab "${method}" dalam 60 detik (timeout)`));
        }, TIMEOUT_REQUEST_MS);
        menunggu.set(id, { resolve, reject, pengatur });
        try {
          tulis({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
        } catch (e) {
          clearTimeout(pengatur);
          menunggu.delete(id);
          reject(new Error(`gagal mengirim ke server MCP "${cfg.nama}": ${(e as Error).message}`));
        }
      });
    },
    beriTahu: async (method, params) => {
      if (ditutup || gagalFatal) return;
      try {
        tulis({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
      } catch {
        // Notifikasi gagal terkirim tidak menggagalkan koneksi.
      }
    },
    tutup: async () => {
      ditutup = true;
      gagalkanSemua(new Error(`koneksi MCP "${cfg.nama}" ditutup`));
      try {
        anak.stdin.end();
      } catch {
        // abaikan
      }
      anak.kill();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Transport HTTP: Streamable HTTP — POST JSON-RPC, jawaban JSON / SSE */
/* ------------------------------------------------------------------ */

function buatKoneksiHttp(cfg: McpServerConfig): KoneksiMcp {
  const url = cfg.url as string;
  let idBerikut = 0;
  let idSesi: string | null = null;
  let ditutup = false;

  const headerDasar = (): Record<string, string> => ({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(cfg.headers ?? {}),
    ...(idSesi ? { "Mcp-Session-Id": idSesi } : {}),
  });

  /** Satu POST dengan timeout; simpan Mcp-Session-Id jawaban bila ada. */
  async function kirimHttp(payload: unknown): Promise<{ status: number; tipeKonten: string; teks: string }> {
    const kontroler = new AbortController();
    const pengatur = setTimeout(() => kontroler.abort(), TIMEOUT_REQUEST_MS);
    try {
      const respons = await fetch(url, {
        method: "POST",
        headers: headerDasar(),
        body: JSON.stringify(payload),
        signal: kontroler.signal,
      });
      const sesiBaru = respons.headers.get("mcp-session-id");
      if (sesiBaru) idSesi = sesiBaru;
      return {
        status: respons.status,
        tipeKonten: respons.headers.get("content-type") ?? "",
        teks: await respons.text(),
      };
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        throw new Error(`server MCP "${cfg.nama}" tidak menjawab dalam 60 detik (timeout)`);
      }
      throw new Error(`gagal menghubungi server MCP "${cfg.nama}" (${url}): ${(e as Error).message}`);
    } finally {
      clearTimeout(pengatur);
    }
  }

  /** Cari pesan JSON-RPC ber-id `id` di dalam teks SSE (kumpulan baris `data:` per event). */
  function cariDiSse(teks: string, id: number): PesanJsonRpc | null {
    let dataGabungan: string[] = [];
    const kandidat: string[] = [];
    for (const barisMentah of teks.split(/\r?\n/)) {
      const baris = barisMentah.trimEnd();
      if (baris === "") {
        if (dataGabungan.length > 0) kandidat.push(dataGabungan.join("\n"));
        dataGabungan = [];
      } else if (baris.startsWith("data:")) {
        dataGabungan.push(baris.slice("data:".length).trim());
      }
    }
    if (dataGabungan.length > 0) kandidat.push(dataGabungan.join("\n"));
    for (const mentah of kandidat) {
      try {
        const pesan = JSON.parse(mentah) as PesanJsonRpc;
        if (pesan && (pesan.id === id || Number(pesan.id) === id)) return pesan;
      } catch {
        // bukan JSON — lewati
      }
    }
    return null;
  }

  return {
    minta: async (method, params) => {
      if (ditutup) throw new Error(`koneksi MCP "${cfg.nama}" sudah ditutup`);
      const id = ++idBerikut;
      const { status, tipeKonten, teks } = await kirimHttp({
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      });
      if (status < 200 || status >= 300) {
        throw new Error(
          `server MCP "${cfg.nama}" menjawab HTTP ${status}${teks ? `: ${teks.replace(/\s+/g, " ").slice(0, 200)}` : ""}`
        );
      }
      let pesan: PesanJsonRpc | null = null;
      if (tipeKonten.includes("text/event-stream")) {
        pesan = cariDiSse(teks, id);
        if (!pesan) throw new Error(`server MCP "${cfg.nama}" tidak mengirim jawaban untuk "${method}" dalam aliran SSE-nya`);
      } else {
        if (!teks.trim()) throw new Error(`server MCP "${cfg.nama}" menjawab kosong untuk "${method}"`);
        try {
          pesan = JSON.parse(teks) as PesanJsonRpc;
        } catch {
          throw new Error(`server MCP "${cfg.nama}" menjawab bukan JSON yang valid untuk "${method}"`);
        }
      }
      if (pesan.error) throw errorDariPesan(pesan);
      return pesan.result;
    },
    beriTahu: async (method, params) => {
      if (ditutup) return;
      try {
        await kirimHttp({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
      } catch {
        // Notifikasi (mis. notifications/initialized) sering dijawab 202 kosong;
        // kegagalannya tidak menggagalkan koneksi.
      }
    },
    tutup: async () => {
      ditutup = true;
      // Akhiri sesi secara sopan bila server memberi id sesi (best-effort).
      if (idSesi) {
        try {
          const kontroler = new AbortController();
          const pengatur = setTimeout(() => kontroler.abort(), 5000);
          try {
            await fetch(url, { method: "DELETE", headers: headerDasar(), signal: kontroler.signal });
          } finally {
            clearTimeout(pengatur);
          }
        } catch {
          // abaikan — sesi akan kedaluwarsa di sisi server
        }
        idSesi = null;
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Handshake + pengelola gabungan                                      */
/* ------------------------------------------------------------------ */

/** Sanitasi nama menjadi karakter yang sah untuk nama tool OpenAI: [a-zA-Z0-9_-]. */
function sanitasi(nama: string): string {
  return nama.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Handshake MCP: initialize → notifications/initialized → tools/list. */
async function jabatTangan(koneksi: KoneksiMcp): Promise<ToolMentah[]> {
  // Versi jawaban server diterima apa adanya (tidak divalidasi ketat): server
  // yang lebih baru/lama tetap dicoba dipakai selama tools/list berhasil.
  await koneksi.minta("initialize", {
    protocolVersion: VERSI_PROTOKOL,
    capabilities: {},
    clientInfo: { name: "vibekit", version: VERSI_KLIEN },
  });
  await koneksi.beriTahu("notifications/initialized");
  const daftar = (await koneksi.minta("tools/list", {})) as { tools?: unknown } | null;
  const mentah = Array.isArray(daftar?.tools) ? daftar.tools : [];
  return mentah.filter(
    (t): t is ToolMentah =>
      !!t && typeof t === "object" && typeof (t as ToolMentah).name === "string" && (t as ToolMentah).name.trim() !== ""
  );
}

/** Ubah hasil tools/call (content blocks) menjadi teks untuk model. */
function hasilKeTeks(hasil: unknown): string {
  const obj = (hasil ?? {}) as { content?: unknown; isError?: boolean };
  const blok = Array.isArray(obj.content) ? obj.content : [];
  const bagian = blok.map((b) => {
    const blokObj = (b ?? {}) as { type?: string; text?: unknown };
    if (blokObj.type === "text" && typeof blokObj.text === "string") return blokObj.text;
    return `[konten ${typeof blokObj.type === "string" ? blokObj.type : "?"}]`;
  });
  const teks = bagian.join("\n");
  if (obj.isError) return `ERROR: ${teks || "(server melaporkan error tanpa teks)"}`;
  return teks || "(tool selesai tanpa keluaran teks)";
}

export interface ToolMcpRingkas {
  /** Nama tool asli di servernya. */
  nama: string;
  /** Nama ter-namespace yang ditawarkan ke model: mcp__<server>__<tool>. */
  namaLengkap: string;
  deskripsi: string;
}

export interface RincianServerMcp {
  nama: string;
  tools: ToolMcpRingkas[];
}

export interface PengelolaMcp {
  /** Definisi tool gabungan (format OpenAI) siap ditawarkan ke model. */
  tools: ToolDefinition[];
  /** Rincian per server yang berhasil tersambung (untuk ditampilkan CLI). */
  rincianServer: RincianServerMcp[];
  /** Peringatan per server yang gagal/tidak menyediakan tool ("<nama>: <pesan>"). */
  peringatan: string[];
  /** Panggil tool berdasarkan nama ter-namespace; kembalikan TEKS hasilnya ("ERROR: ..." bila server melaporkan error). */
  panggilTool: (namaLengkap: string, argumen: Record<string, unknown>) => Promise<string>;
  /** Putuskan semua sambungan (bunuh proses anak stdio). */
  tutupSemua: () => Promise<void>;
}

/**
 * Sambungkan semua server MCP dari konfigurasi. Kegagalan SATU server tidak
 * menggagalkan yang lain: server yang gagal dicatat di `peringatan`, server
 * sehat tetap terdaftar tool-nya.
 */
export async function sambungkanMcpServers(configs: McpServerConfig[]): Promise<PengelolaMcp> {
  const tools: ToolDefinition[] = [];
  const rincianServer: RincianServerMcp[] = [];
  const peringatan: string[] = [];
  const rute = new Map<string, { koneksi: KoneksiMcp; namaTool: string }>();
  const koneksiAktif: KoneksiMcp[] = [];

  for (const cfg of configs) {
    let koneksi: KoneksiMcp | null = null;
    try {
      koneksi = cfg.url ? buatKoneksiHttp(cfg) : buatKoneksiStdio(cfg);
      const daftarTool = await jabatTangan(koneksi);
      if (daftarTool.length === 0) {
        peringatan.push(`${cfg.nama}: server tersambung tetapi tidak menyediakan tool yang valid — dilewati.`);
        await koneksi.tutup().catch(() => {});
        continue;
      }
      const ringkas: ToolMcpRingkas[] = [];
      for (const t of daftarTool) {
        const namaLengkap = `mcp__${sanitasi(cfg.nama)}__${sanitasi(t.name)}`;
        if (rute.has(namaLengkap)) {
          peringatan.push(`${cfg.nama}: nama tool ter-namespace "${namaLengkap}" bertabrakan — yang kedua dilewati.`);
          continue;
        }
        rute.set(namaLengkap, { koneksi, namaTool: t.name });
        tools.push({
          type: "function",
          function: {
            name: namaLengkap,
            description: typeof t.description === "string" ? t.description : "",
            parameters:
              t.inputSchema && typeof t.inputSchema === "object"
                ? t.inputSchema
                : { type: "object", properties: {} },
          },
        });
        ringkas.push({
          nama: t.name,
          namaLengkap,
          deskripsi: typeof t.description === "string" ? t.description : "",
        });
      }
      koneksiAktif.push(koneksi);
      rincianServer.push({ nama: cfg.nama, tools: ringkas });
    } catch (e) {
      peringatan.push(`${cfg.nama}: gagal tersambung — ${(e as Error).message}`);
      if (koneksi) await koneksi.tutup().catch(() => {});
    }
  }

  return {
    tools,
    rincianServer,
    peringatan,
    panggilTool: async (namaLengkap, argumen) => {
      const r = rute.get(namaLengkap);
      if (!r) throw new Error(`tool MCP tidak ditemukan: ${namaLengkap}`);
      const hasil = await r.koneksi.minta("tools/call", { name: r.namaTool, arguments: argumen ?? {} });
      return hasilKeTeks(hasil);
    },
    tutupSemua: async () => {
      for (const k of koneksiAktif) {
        try {
          await k.tutup();
        } catch {
          // abaikan — penutupan best-effort
        }
      }
    },
  };
}
