/**
 * Server MCP VibeKit ("layani") — kebalikan dari src/mcp.ts: di sana VibeKit
 * adalah *client* yang memakai tool server lain; di sini VibeKit adalah
 * *server* yang melayani folder kerja (cwd) kepada agen AI eksternal
 * (mis. Muse lewat konektor khusus, atau client MCP lain) melalui
 * Streamable HTTP + JSON-RPC 2.0, tanpa dependency baru.
 *
 * Model keamanan (berlapis, tidak ada yang opsional kecuali --auto):
 *  1. Token Bearer wajib di setiap request (401 tanpa token yang benar).
 *  2. Semua tool dieksekusi lewat eksekusiTool mode agent: pagar folder
 *     kerja (path traversal ditolak) dan hasil dipangkas seperti biasa.
 *  3. Aksi mutasi (tulis_file, edit_file, jalankan_perintah) meminta
 *     konfirmasi di terminal tempat server berjalan — kecuali flag --auto.
 *  4. Server hanya hidup selama perintah berjalan; Ctrl+C memutus akses.
 *
 * Yang dilayani persis 5 tool bawaan mode agent (daftar_file, baca_file,
 * tulis_file, edit_file, jalankan_perintah) dengan skema dari DEFINISI_TOOL.
 */
import crypto from "node:crypto";
import http from "node:http";
import { DEFINISI_TOOL, eksekusiTool, type Konfirmasi } from "./agent.js";
import type { ToolCall } from "./types.js";

/** Versi protokol MCP yang ditawarkan server ini (samakan dengan client di mcp.ts). */
const VERSI_PROTOKOL = "2025-03-26";
/** Nama serverInfo pada jawaban initialize. */
export const NAMA_SERVER_LAYANI = "vibekit-layani";
/** Batas ukuran body satu request HTTP. */
const BATAS_BODY = 4 * 1024 * 1024;

export interface OpsiServerLayani {
  /** Folder yang dilayani (akar pagar keamanan). */
  cwd: string;
  /** Alamat bind; bawaan diputuskan pemanggil (CLI memakai 127.0.0.1). */
  host: string;
  /** Port TCP; 0 = minta port bebas dari OS (dipakai tes). */
  port: number;
  /** Token Bearer yang wajib dikirim client. */
  token: string;
  /** Versi VibeKit untuk serverInfo (diambil dari VERSI CLI). */
  versi: string;
  /** Callback konfirmasi terminal untuk aksi mutasi. */
  konfirmasi: Konfirmasi;
  /** true = lewati konfirmasi (mode auto-allow); pagar cwd tetap berlaku. */
  autoAllow?: boolean;
  /** Pencatat aktivitas; bawaan console.log pemanggil. */
  log?: (pesan: string) => void;
}

export interface ServerLayaniBerjalan {
  /** Port aktual server mendengarkan (relevan bila opsi port = 0). */
  port: number;
  /** Host yang dipakai. */
  host: string;
  /** Hentikan server (tutup listener). */
  tutup: () => Promise<void>;
}

interface PesanJsonRpc {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
}

/** Buat token acak baru untuk server layani (hex 32 karakter). */
export function buatTokenLayani(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** Perbandingan token yang tidak bocor lewat timing. */
function tokenCocok(diberikan: string | undefined, diharapkan: string): boolean {
  if (!diberikan) return false;
  const a = Buffer.from(diberikan);
  const b = Buffer.from(diharapkan);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Mulai server MCP layani. Mengembalikan handle berisi port aktual dan
 * fungsi tutup. Tidak pernah menyelesaikan sendiri — server hidup sampai
 * tutup() dipanggil atau proses berakhir.
 */
export async function mulaiServerLayani(opsi: OpsiServerLayani): Promise<ServerLayaniBerjalan> {
  const log = opsi.log ?? ((pesan: string) => console.log(pesan));
  const cwd = opsi.cwd;

  const daftarToolMcp = DEFINISI_TOOL.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
  }));

  async function tanganiPesan(pesan: PesanJsonRpc): Promise<{ status: number; body?: unknown }> {
    const adalahNotifikasi = pesan.id === undefined;
    // Notifikasi (mis. notifications/initialized): diterima, tanpa jawaban.
    if (adalahNotifikasi) return { status: 202 };
    const id = pesan.id as number | string;
    const jawab = (result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id, result } });
    const jawabError = (code: number, message: string) => ({
      status: 200,
      body: { jsonrpc: "2.0", id, error: { code, message } },
    });

    switch (pesan.method) {
      case "initialize": {
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: VERSI_PROTOKOL,
              capabilities: { tools: {} },
              serverInfo: { name: NAMA_SERVER_LAYANI, version: opsi.versi },
            },
          },
        };
      }
      case "ping":
        return jawab({});
      case "tools/list":
        return jawab({ tools: daftarToolMcp });
      case "tools/call": {
        const params = (pesan.params ?? {}) as { name?: unknown; arguments?: unknown };
        const nama = typeof params.name === "string" ? params.name : "";
        const argumen =
          params.arguments && typeof params.arguments === "object"
            ? (params.arguments as Record<string, unknown>)
            : {};
        if (!daftarToolMcp.some((t) => t.name === nama)) {
          return jawabError(-32602, `tool tidak dikenal: ${nama || "(kosong)"}`);
        }
        log(`[layani] tools/call ${nama} ${ringkasArgumen(nama, argumen)}`);
        const panggilan: ToolCall = {
          id: `layani-${String(id)}`,
          type: "function",
          function: { name: nama, arguments: JSON.stringify(argumen) },
        };
        const hasil = await eksekusiTool(panggilan, {
          cwd,
          konfirmasi: opsi.konfirmasi,
          autoAllow: opsi.autoAllow,
        });
        const gagal = hasil.startsWith("ERROR:") || hasil.startsWith("DITOLAK:");
        log(`[layani] → ${gagal ? "gagal/ditolak" : "OK"} (${hasil.length} karakter hasil)`);
        return jawab({
          content: [{ type: "text", text: hasil }],
          isError: gagal,
        });
      }
      default:
        return jawabError(-32601, `method tidak dikenal: ${pesan.method ?? "(kosong)"}`);
    }
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      // Hanya POST yang bermakna pada Streamable HTTP server sederhana ini;
      // GET (stream dari server) tidak didukung → 405 sesuai spesifikasi.
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method tidak didukung; gunakan POST" }));
        return;
      }
      // Pintu pertama: token Bearer wajib, sebelum body dibaca.
      const otorisasi = req.headers["authorization"];
      const diberikan =
        typeof otorisasi === "string" && otorisasi.startsWith("Bearer ")
          ? otorisasi.slice("Bearer ".length).trim()
          : undefined;
      if (!tokenCocok(diberikan, opsi.token)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "token tidak ada atau salah" }));
        return;
      }
      // Baca body dengan batas ukuran.
      const potongan: Buffer[] = [];
      let total = 0;
      for await (const potong of req) {
        total += (potong as Buffer).length;
        if (total > BATAS_BODY) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "body terlalu besar" }));
          return;
        }
        potongan.push(potong as Buffer);
      }
      let pesan: PesanJsonRpc;
      try {
        pesan = JSON.parse(Buffer.concat(potongan).toString("utf8")) as PesanJsonRpc;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "body bukan JSON yang valid" } })
        );
        return;
      }
      if (Array.isArray(pesan)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch tidak didukung" } })
        );
        return;
      }
      const { status, body } = await tanganiPesan(pesan);
      if (status === 202 || body === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const header: Record<string, string> = { "Content-Type": "application/json" };
      // Terbitkan id sesi pada jawaban initialize agar client Streamable HTTP
      // (termasuk client VibeKit sendiri) bisa menyimpannya; server ini
      // sendiri tidak mewajibkannya pada request berikutnya.
      if (pesan.method === "initialize") {
        header["Mcp-Session-Id"] = crypto.randomUUID();
      }
      res.writeHead(status, header);
      res.end(JSON.stringify(body));
    })().catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `kesalahan internal: ${(e as Error).message}` }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opsi.port, opsi.host, () => resolve());
  });
  const alamat = server.address();
  const portAktual = typeof alamat === "object" && alamat !== null ? alamat.port : opsi.port;

  return {
    port: portAktual,
    host: opsi.host,
    tutup: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Ringkasan argumen satu baris untuk log server (tanpa membocorkan isi file). */
function ringkasArgumen(nama: string, arg: Record<string, unknown>): string {
  if (nama === "jalankan_perintah") return `perintah="${String(arg.perintah ?? "").slice(0, 80)}"`;
  if (typeof arg.path === "string") return `path=${arg.path}`;
  return "";
}
