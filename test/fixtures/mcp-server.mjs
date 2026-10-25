#!/usr/bin/env node
/**
 * Server MCP stdio (NDJSON) MINIMAL untuk pengujian VibeKit — bukan untuk produksi.
 *
 * Menangani: initialize, notifications/initialized (diabaikan), tools/list,
 * tools/call. Dua tool:
 *   - "sapa"  {nama} → content teks "Halo, <nama>!"
 *   - "gagal" {}     → hasil dengan isError: true
 *
 * Bila variabel lingkungan VK_UJI_PENANDA terisi (path file), setiap panggilan
 * tools/call dicatat sebagai satu baris "call:<namaTool>" ke file itu — dipakai
 * tes untuk membuktikan tool benar-benar dipanggil (atau TIDAK dipanggil).
 */
import fs from "node:fs";
import readline from "node:readline";

const FILE_PENANDA = process.env.VK_UJI_PENANDA || "";

function catatPanggilan(namaTool) {
  if (FILE_PENANDA) {
    try {
      fs.appendFileSync(FILE_PENANDA, `call:${namaTool}\n`, "utf8");
    } catch {
      // penanda gagal ditulis tidak boleh menjatuhkan server uji
    }
  }
}

const DAFTAR_TOOL = [
  {
    name: "sapa",
    description: "Menyapa seseorang dengan nama.",
    inputSchema: {
      type: "object",
      properties: { nama: { type: "string", description: "Nama yang disapa." } },
      required: ["nama"],
    },
  },
  {
    name: "gagal",
    description: "Tool uji yang selalu melaporkan error (isError).",
    inputSchema: { type: "object", properties: {} },
  },
];

function kirim(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (baris) => {
  const teks = baris.trim();
  if (!teks) return;
  let pesan;
  try {
    pesan = JSON.parse(teks);
  } catch {
    return;
  }
  switch (pesan.method) {
    case "initialize":
      kirim({
        jsonrpc: "2.0",
        id: pesan.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "mcp-server-uji", version: "1.0.0" },
        },
      });
      break;
    case "notifications/initialized":
      // Notifikasi: tidak dijawab.
      break;
    case "tools/list":
      kirim({ jsonrpc: "2.0", id: pesan.id, result: { tools: DAFTAR_TOOL } });
      break;
    case "tools/call": {
      const namaTool = pesan.params?.name;
      catatPanggilan(namaTool);
      if (namaTool === "sapa") {
        const nama = pesan.params?.arguments?.nama ?? "?";
        kirim({
          jsonrpc: "2.0",
          id: pesan.id,
          result: { content: [{ type: "text", text: `Halo, ${nama}!` }] },
        });
      } else if (namaTool === "gagal") {
        kirim({
          jsonrpc: "2.0",
          id: pesan.id,
          result: { content: [{ type: "text", text: "ledakan uji dari tool gagal" }], isError: true },
        });
      } else if (pesan.id !== undefined) {
        kirim({
          jsonrpc: "2.0",
          id: pesan.id,
          error: { code: -32602, message: `tool tidak dikenal: ${namaTool}` },
        });
      }
      break;
    }
    default:
      if (pesan.id !== undefined) {
        kirim({
          jsonrpc: "2.0",
          id: pesan.id,
          error: { code: -32601, message: `method tidak dikenal: ${pesan.method}` },
        });
      }
  }
});
