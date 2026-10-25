import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { mulaiServerLayani } from "../dist/layani.js";

const TOKEN = "token-tes-rahasia";

/** Jalankan server layani pada folder sementara; selalu ditutup setelah fn selesai. */
async function denganServer(opsiEkstra, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibekit-layani-test-"));
  const cwd = path.join(dir, "kerja");
  fs.mkdirSync(cwd);
  const server = await mulaiServerLayani({
    cwd,
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    versi: "0.7.0-uji",
    konfirmasi: async () => true,
    log: () => {},
    ...opsiEkstra,
  });
  try {
    await fn({ dir, cwd, port: server.port });
  } finally {
    await server.tutup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** POST satu pesan JSON-RPC; kembalikan { status, header, json }. */
async function kirim(port, payload, { token = TOKEN, method = "POST" } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(payload) : undefined,
  });
  const teks = await res.text();
  let json = null;
  try {
    json = JSON.parse(teks);
  } catch {
    // body kosong (202) memang bukan JSON
  }
  return { status: res.status, headers: res.headers, json, teks };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "uji", version: "0" } },
};

test("(layani-a) request tanpa token / token salah ditolak 401", async () => {
  await denganServer({}, async ({ port }) => {
    const tanpa = await kirim(port, INIT, { token: null });
    assert.equal(tanpa.status, 401);
    const salah = await kirim(port, INIT, { token: "bukan-tokennya" });
    assert.equal(salah.status, 401);
    const benar = await kirim(port, INIT);
    assert.equal(benar.status, 200);
  });
});

test("(layani-b) initialize menjawab serverInfo vibekit-layani + Mcp-Session-Id", async () => {
  await denganServer({}, async ({ port }) => {
    const r = await kirim(port, INIT);
    assert.equal(r.status, 200);
    assert.equal(r.json.result.serverInfo.name, "vibekit-layani");
    assert.equal(r.json.result.protocolVersion, "2025-03-26");
    assert.ok(r.headers.get("mcp-session-id"), "header Mcp-Session-Id harus ada");
  });
});

test("(layani-c) notifikasi initialized diterima 202 tanpa body", async () => {
  await denganServer({}, async ({ port }) => {
    const r = await kirim(port, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(r.status, 202);
    assert.equal(r.teks, "");
  });
});

test("(layani-d) tools/list memuat 5 tool bawaan mode agent", async () => {
  await denganServer({}, async ({ port }) => {
    const r = await kirim(port, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const nama = r.json.result.tools.map((t) => t.name);
    assert.deepEqual(nama, ["daftar_file", "baca_file", "tulis_file", "edit_file", "jalankan_perintah"]);
    for (const t of r.json.result.tools) {
      assert.equal(t.inputSchema.type, "object");
      assert.ok(typeof t.description === "string" && t.description.length > 0);
    }
  });
});

test("(layani-e) tools/call baca_file & daftar_file membaca folder yang dilayani", async () => {
  await denganServer({}, async ({ cwd, port }) => {
    fs.writeFileSync(path.join(cwd, "halo.txt"), "isi berkas uji", "utf8");
    const baca = await kirim(port, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "baca_file", arguments: { path: "halo.txt" } },
    });
    assert.equal(baca.json.result.isError, false);
    assert.match(baca.json.result.content[0].text, /isi berkas uji/);
    const daftar = await kirim(port, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "daftar_file", arguments: {} },
    });
    assert.equal(daftar.json.result.isError, false);
    assert.match(daftar.json.result.content[0].text, /halo\.txt/);
  });
});

test("(layani-f) pagar folder: path traversal ditolak untuk baca maupun tulis", async () => {
  await denganServer({ autoAllow: true }, async ({ dir, port }) => {
    fs.writeFileSync(path.join(dir, "rahasia.txt"), "jangan sampai terbaca", "utf8");
    const baca = await kirim(port, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "baca_file", arguments: { path: "../rahasia.txt" } },
    });
    assert.equal(baca.json.result.isError, true);
    assert.doesNotMatch(baca.json.result.content[0].text, /jangan sampai terbaca/);
    const tulis = await kirim(port, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "tulis_file", arguments: { path: "../jahat.txt", konten: "x" } },
    });
    assert.equal(tulis.json.result.isError, true);
    assert.equal(fs.existsSync(path.join(dir, "jahat.txt")), false);
  });
});

test("(layani-g) mode auto: tulis_file, edit_file, jalankan_perintah berjalan tanpa konfirmasi", async () => {
  let dipanggil = 0;
  await denganServer(
    {
      autoAllow: true,
      konfirmasi: async () => {
        dipanggil++;
        return false; // bila sempat dipanggil pun jawabannya menolak — auto tidak boleh memanggilnya
      },
    },
    async ({ cwd, port }) => {
      const tulis = await kirim(port, {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "tulis_file", arguments: { path: "baru.txt", konten: "satu dua" } },
      });
      assert.equal(tulis.json.result.isError, false);
      assert.equal(fs.readFileSync(path.join(cwd, "baru.txt"), "utf8"), "satu dua");
      const edit = await kirim(port, {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "edit_file", arguments: { path: "baru.txt", teksLama: "dua", teksBaru: "tiga" } },
      });
      assert.equal(edit.json.result.isError, false);
      assert.equal(fs.readFileSync(path.join(cwd, "baru.txt"), "utf8"), "satu tiga");
      const jalan = await kirim(port, {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "jalankan_perintah", arguments: { perintah: 'node -e "console.log(40+2)"' } },
      });
      assert.equal(jalan.json.result.isError, false);
      assert.match(jalan.json.result.content[0].text, /42/);
      assert.equal(dipanggil, 0, "callback konfirmasi tidak boleh dipanggil sama sekali pada mode auto");
    }
  );
});

test("(layani-h) tanpa auto: konfirmasi menolak menggagalkan tulis; menerima menjalankannya", async () => {
  let keputusan = false;
  const deskripsiTerlihat = [];
  await denganServer(
    {
      autoAllow: false,
      konfirmasi: async (deskripsi) => {
        deskripsiTerlihat.push(deskripsi);
        return keputusan;
      },
    },
    async ({ cwd, port }) => {
      const tolak = await kirim(port, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "tulis_file", arguments: { path: "ditolak.txt", konten: "x" } },
      });
      assert.equal(tolak.json.result.isError, true);
      assert.match(tolak.json.result.content[0].text, /DITOLAK/);
      assert.equal(fs.existsSync(path.join(cwd, "ditolak.txt")), false);
      keputusan = true;
      const terima = await kirim(port, {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "tulis_file", arguments: { path: "diterima.txt", konten: "y" } },
      });
      assert.equal(terima.json.result.isError, false);
      assert.equal(fs.readFileSync(path.join(cwd, "diterima.txt"), "utf8"), "y");
      assert.equal(deskripsiTerlihat.length, 2, "konfirmasi diminta sekali per aksi mutasi");
    }
  );
});

test("(layani-i) method tak dikenal → error JSON-RPC -32601; tool tak dikenal → -32602", async () => {
  await denganServer({}, async ({ port }) => {
    const m = await kirim(port, { jsonrpc: "2.0", id: 12, method: "resources/list" });
    assert.equal(m.json.error.code, -32601);
    const t = await kirim(port, {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "hapus_semua", arguments: {} },
    });
    assert.equal(t.json.error.code, -32602);
  });
});

test("(layani-j) GET ditolak 405 (server ini hanya melayani POST)", async () => {
  await denganServer({}, async ({ port }) => {
    const r = await kirim(port, null, { method: "GET" });
    assert.equal(r.status, 405);
  });
});
