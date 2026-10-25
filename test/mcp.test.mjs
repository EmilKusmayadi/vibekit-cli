import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { jalankanGiliran, kompaksiRiwayatAksi } from "../dist/agent.js";
import { sambungkanMcpServers } from "../dist/mcp.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-server.mjs");
const serverBerjalan = [];

function buatSementara() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibekit-mcp-test-"));
  const cwd = path.join(dir, "kerja");
  fs.mkdirSync(cwd);
  return { dir, cwd, lokasiState: path.join(dir, "state.json") };
}

/* ---------------- Penyedia model tiruan (untuk integrasi agent) ------------- */

function mulaiServerPenyedia(penangan) {
  return new Promise((resolve) => {
    const panggilan = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        panggilan.push({ url: req.url, body });
        penangan(req, res, body, panggilan.length);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      serverBerjalan.push(server);
      resolve({ server, panggilan, alamat: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

function balasTeks(res, konten, totalToken = 100) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: konten } }],
      usage: { prompt_tokens: 50, completion_tokens: totalToken - 50, total_tokens: totalToken },
    })
  );
}

function balasToolCalls(res, daftar, totalToken = 100) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: daftar.map((d, i) => ({
              id: `panggilan-${i + 1}`,
              type: "function",
              function: { name: d.nama, arguments: JSON.stringify(d.argumen) },
            })),
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: totalToken - 50, total_tokens: totalToken },
    })
  );
}

function configUntuk(alamat) {
  return {
    providers: [{ nama: "tiruan", baseUrl: alamat, apiKey: "kunci-uji", model: "model-tiruan", jedaCooldownMenit: 15 }],
    gaya: { jawaban: "poin-penting", maksTokenJawaban: 800 },
  };
}

/* ---------------- Server MCP HTTP tiruan (JSON biasa & SSE) ---------------- */

function mulaiServerMcpHttp({ sse = false } = {}) {
  return new Promise((resolve) => {
    const terlihat = { sesiPadaToolsList: null, sesiPadaToolsCall: null };
    const server = http.createServer((req, res) => {
      if (req.method === "DELETE") {
        res.writeHead(200);
        res.end();
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let pesan;
        try {
          pesan = JSON.parse(body);
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        if (pesan.id === undefined) {
          // Notifikasi (notifications/initialized): cukup 202 tanpa body.
          res.writeHead(202);
          res.end();
          return;
        }
        let hasil;
        if (pesan.method === "initialize") {
          hasil = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "mcp-http-uji", version: "1.0.0" },
          };
        } else if (pesan.method === "tools/list") {
          terlihat.sesiPadaToolsList = req.headers["mcp-session-id"] ?? null;
          hasil = {
            tools: [
              {
                name: "tambah",
                description: "Menjumlahkan dua angka.",
                inputSchema: {
                  type: "object",
                  properties: { a: { type: "number" }, b: { type: "number" } },
                  required: ["a", "b"],
                },
              },
            ],
          };
        } else if (pesan.method === "tools/call") {
          terlihat.sesiPadaToolsCall = req.headers["mcp-session-id"] ?? null;
          const { a = 0, b = 0 } = pesan.params?.arguments ?? {};
          hasil = { content: [{ type: "text", text: `Jumlahnya ${a + b}` }] };
        } else {
          res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sesi-uji-1" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: pesan.id, error: { code: -32601, message: "method tidak dikenal" } }));
          return;
        }
        const payload = { jsonrpc: "2.0", id: pesan.id, result: hasil };
        if (sse) {
          // SSE: kirim dulu event notifikasi (tanpa id yang cocok), baru responsnya.
          res.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "sesi-uji-1" });
          res.end(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } })}\n\n` +
              `event: message\ndata: ${JSON.stringify(payload)}\n\n`
          );
        } else {
          res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sesi-uji-1" });
          res.end(JSON.stringify(payload));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      serverBerjalan.push(server);
      resolve({ server, terlihat, url: `http://127.0.0.1:${server.address().port}/mcp` });
    });
  });
}

after(() => {
  for (const s of serverBerjalan) s.close();
});

/* --------------------------------- Tes ----------------------------------- */

test("(t) mcp stdio: sambung fixture → tool ter-namespace, panggil sapa & gagal, tutup bersih", async () => {
  const pengelola = await sambungkanMcpServers([
    { nama: "uji", perintah: process.execPath, argumen: [FIXTURE] },
  ]);
  try {
    assert.deepEqual(pengelola.peringatan, [], "fixture sehat tidak boleh menghasilkan peringatan");
    assert.equal(pengelola.rincianServer.length, 1);
    assert.equal(pengelola.rincianServer[0].nama, "uji");
    const namaTool = pengelola.tools.map((t) => t.function.name).sort();
    assert.deepEqual(namaTool, ["mcp__uji__gagal", "mcp__uji__sapa"], "nama tool harus ter-namespace mcp__uji__<tool>");

    const sapa = pengelola.tools.find((t) => t.function.name === "mcp__uji__sapa");
    assert.equal(sapa.type, "function");
    assert.match(sapa.function.description, /Menyapa/);
    assert.equal(sapa.function.parameters.required[0], "nama", "inputSchema server diteruskan sebagai parameters");

    const teks = await pengelola.panggilTool("mcp__uji__sapa", { nama: "Emil" });
    assert.equal(teks, "Halo, Emil!");

    const gagal = await pengelola.panggilTool("mcp__uji__gagal", {});
    assert.ok(gagal.startsWith("ERROR:"), `hasil isError harus diawali "ERROR:", dapat: ${gagal}`);
    assert.match(gagal, /ledakan uji/);
  } finally {
    await pengelola.tutupSemua();
  }
});

test("(u) mcp http: transport JSON biasa + Mcp-Session-Id diteruskan antar-request", async () => {
  const tiruan = await mulaiServerMcpHttp({ sse: false });
  const pengelola = await sambungkanMcpServers([{ nama: "web", url: tiruan.url }]);
  try {
    assert.deepEqual(pengelola.peringatan, []);
    const namaTool = pengelola.tools.map((t) => t.function.name);
    assert.deepEqual(namaTool, ["mcp__web__tambah"]);
    const hasil = await pengelola.panggilTool("mcp__web__tambah", { a: 2, b: 3 });
    assert.equal(hasil, "Jumlahnya 5");
    // Server memberi Mcp-Session-Id saat initialize; request berikutnya wajib membawanya.
    assert.equal(tiruan.terlihat.sesiPadaToolsList, "sesi-uji-1");
    assert.equal(tiruan.terlihat.sesiPadaToolsCall, "sesi-uji-1");
  } finally {
    await pengelola.tutupSemua();
  }
});

test("(u2) mcp http: jawaban berbentuk SSE (text/event-stream) tetap terbaca", async () => {
  const tiruan = await mulaiServerMcpHttp({ sse: true });
  const pengelola = await sambungkanMcpServers([{ nama: "web", url: tiruan.url }]);
  try {
    assert.deepEqual(pengelola.peringatan, []);
    assert.deepEqual(pengelola.tools.map((t) => t.function.name), ["mcp__web__tambah"]);
    const hasil = await pengelola.panggilTool("mcp__web__tambah", { a: 10, b: 7 });
    assert.equal(hasil, "Jumlahnya 17");
  } finally {
    await pengelola.tutupSemua();
  }
});

test("(v) mcp integrasi agent: tool_call ke tool MCP + konfirmasi setuju → tool terpanggil, hasil masuk giliran", async () => {
  const { dir, cwd, lokasiState } = buatSementara();
  const filePenanda = path.join(dir, "penanda.txt");
  const tiruan = await mulaiServerPenyedia((req, res, body, ke) => {
    if (ke === 1) {
      const terkirim = JSON.parse(body);
      assert.ok(
        terkirim.tools.some((t) => t.function.name === "mcp__uji__sapa"),
        "tool MCP harus ikut ditawarkan ke model bersama tool bawaan"
      );
      assert.equal(terkirim.tools.length, 7, "5 tool bawaan + 2 tool MCP fixture");
      balasToolCalls(res, [{ nama: "mcp__uji__sapa", argumen: { nama: "Emil" } }]);
    } else {
      balasTeks(res, "Sudah disapa lewat MCP.");
    }
  });
  const pengelola = await sambungkanMcpServers([
    { nama: "uji", perintah: process.execPath, argumen: [FIXTURE], env: { VK_UJI_PENANDA: filePenanda } },
  ]);
  try {
    const konfirmasiDilihat = [];
    const messages = [
      { role: "system", content: "prompt sistem uji" },
      { role: "user", content: "sapa Emil lewat tool MCP" },
    ];
    const hasil = await jalankanGiliran({
      config: configUntuk(tiruan.alamat),
      messages,
      lokasiState,
      cwd,
      konfirmasi: async (deskripsi) => {
        konfirmasiDilihat.push(deskripsi);
        return true;
      },
      toolEkstra: pengelola.tools,
      eksekutorEkstra: (nama, argumen) => pengelola.panggilTool(nama, argumen),
    });

    assert.equal(hasil.ok, true);
    assert.equal(hasil.jawabanAkhir, "Sudah disapa lewat MCP.");
    // Tool MCP = aksi: wajib konfirmasi, dan pratinjaunya menyebut nama tool-nya.
    assert.equal(konfirmasiDilihat.length, 1);
    assert.match(konfirmasiDilihat[0], /mcp__uji__sapa/);
    // Fixture benar-benar menerima panggilan tools/call.
    assert.match(fs.readFileSync(filePenanda, "utf8"), /call:sapa/);
    // Hasil tool yang dikirim balik ke model melaporkan sapaan dari server MCP.
    const pesanTool = messages.filter((m) => m.role === "tool");
    assert.equal(pesanTool.length, 1);
    assert.match(pesanTool[0].content, /^OK:/);
    assert.match(pesanTool[0].content, /Halo, Emil!/);
  } finally {
    await pengelola.tutupSemua();
  }
});

test("(v2) mcp integrasi agent: konfirmasi menolak → tool MCP TIDAK dipanggil sama sekali", async () => {
  const { dir, cwd, lokasiState } = buatSementara();
  const filePenanda = path.join(dir, "penanda.txt");
  const tiruan = await mulaiServerPenyedia((req, res, body, ke) => {
    if (ke === 1) {
      balasToolCalls(res, [{ nama: "mcp__uji__sapa", argumen: { nama: "Emil" } }]);
    } else {
      balasTeks(res, "Baik, tidak jadi menyapa.");
    }
  });
  const pengelola = await sambungkanMcpServers([
    { nama: "uji", perintah: process.execPath, argumen: [FIXTURE], env: { VK_UJI_PENANDA: filePenanda } },
  ]);
  try {
    const messages = [{ role: "user", content: "sapa Emil lewat tool MCP" }];
    const hasil = await jalankanGiliran({
      config: configUntuk(tiruan.alamat),
      messages,
      lokasiState,
      cwd,
      konfirmasi: async () => false,
      toolEkstra: pengelola.tools,
      eksekutorEkstra: (nama, argumen) => pengelola.panggilTool(nama, argumen),
    });

    assert.equal(hasil.ok, true);
    assert.equal(hasil.jawabanAkhir, "Baik, tidak jadi menyapa.");
    // Penanda panggilan hanya ditulis fixture saat tools/call benar-benar tiba.
    assert.equal(fs.existsSync(filePenanda), false, "tool yang ditolak tidak boleh sampai ke server MCP");
    const pesanTool = messages.filter((m) => m.role === "tool");
    assert.equal(pesanTool.length, 1);
    assert.match(pesanTool[0].content, /^DITOLAK:/);
  } finally {
    await pengelola.tutupSemua();
  }
});

test("(w) mcp: satu server rusak tidak menggagalkan server sehat; peringatan terkumpul", async () => {
  const pengelola = await sambungkanMcpServers([
    { nama: "rusak", perintah: "perintah-yang-pasti-tidak-ada-vibekit-xyz" },
    { nama: "uji", perintah: process.execPath, argumen: [FIXTURE] },
  ]);
  try {
    assert.deepEqual(
      pengelola.tools.map((t) => t.function.name).sort(),
      ["mcp__uji__gagal", "mcp__uji__sapa"],
      "tool server sehat tetap terdaftar"
    );
    assert.equal(pengelola.rincianServer.length, 1);
    assert.equal(pengelola.rincianServer[0].nama, "uji");
    assert.equal(pengelola.peringatan.length, 1);
    assert.match(pengelola.peringatan[0], /^rusak: /);
    // Server sehat benar-benar bisa dipakai.
    assert.equal(await pengelola.panggilTool("mcp__uji__sapa", { nama: "Dunia" }), "Halo, Dunia!");
  } finally {
    await pengelola.tutupSemua();
  }
});

test("(x) mcp: kompaksiRiwayatAksi meringkas panggilan tool MCP tanpa crash (argumen tanpa path)", () => {
  const giliran1 = [
    { role: "user", content: "sapa Emil lewat MCP" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "panggilan-1",
          type: "function",
          function: { name: "mcp__uji__sapa", arguments: JSON.stringify({ nama: "Emil" }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "panggilan-1", name: "mcp__uji__sapa", content: "OK: Halo, Emil!" },
    { role: "assistant", content: "Sudah disapa." },
  ];
  const giliran2 = [
    { role: "user", content: "lanjut pertanyaan lain" },
    { role: "assistant", content: "jawaban lain" },
  ];
  const riwayat = [...giliran1, ...giliran2];

  const hasil = kompaksiRiwayatAksi(riwayat);
  const ringkasan = hasil.find(
    (m) => m.role === "assistant" && typeof m.content === "string" && m.content.startsWith("[Aksi selesai:")
  );
  assert.ok(ringkasan, "harus ada ringkasan aksi untuk giliran MCP lama");
  assert.match(ringkasan.content, /mcp__uji__sapa/, "ringkasan menyebut nama tool ter-namespace");
  assert.match(ringkasan.content, /uji\/sapa/, "target ringkasan = nama server + nama tool");
  assert.match(ringkasan.content, /OK/);
  assert.deepEqual(hasil.slice(-2), giliran2, "giliran terakhir tidak disentuh");
});
