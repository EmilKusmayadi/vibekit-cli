import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { jalankanAgent } from "../dist/agent.js";

const serverBerjalan = [];

function mulaiServer(penangan) {
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
      const alamat = `http://127.0.0.1:${server.address().port}/v1`;
      serverBerjalan.push(server);
      resolve({ server, panggilan, alamat });
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
              ...(d.tandaTangan
                ? { extra_content: { google: { thought_signature: d.tandaTangan } } }
                : {}),
            })),
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: totalToken - 50, total_tokens: totalToken },
    })
  );
}

function buatSementara() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibekit-agent-test-"));
  const cwd = path.join(dir, "kerja");
  fs.mkdirSync(cwd);
  return { dir, cwd, lokasiState: path.join(dir, "state.json") };
}

function penyedia(baseUrl) {
  return { nama: "tiruan", baseUrl, apiKey: "kunci-uji", model: "model-tiruan", jedaCooldownMenit: 15 };
}

function configUntuk(alamat) {
  return { providers: [penyedia(alamat)], gaya: { jawaban: "poin-penting", maksTokenJawaban: 800 } };
}

/** Ambil semua pesan role "tool" dari body panggilan HTTP ke-n (1-based). */
function pesanTool(panggilan, ke) {
  const body = JSON.parse(panggilan[ke - 1].body);
  return body.messages.filter((m) => m.role === "tool");
}

after(() => {
  for (const s of serverBerjalan) s.close();
});

test("(h) agent: tool_calls tulis_file → file tercipta persis, berakhir dengan ringkasan teks model", async () => {
  const konten = "Halo dari agent!\nBaris kedua.";
  const tiruan = await mulaiServer((req, res, body, ke) => {
    if (ke === 1) {
      // Pastikan definisi tools benar-benar dikirim ke penyedia.
      const terkirim = JSON.parse(body);
      assert.ok(Array.isArray(terkirim.tools) && terkirim.tools.length === 5, "router harus meneruskan 5 definisi tool");
      balasToolCalls(res, [{ nama: "tulis_file", argumen: { path: "halo.txt", konten }, tandaTangan: "TANDA-UJI-123" }]);
    } else {
      balasTeks(res, "Selesai: file halo.txt dibuat.");
    }
  });
  const { cwd, lokasiState } = buatSementara();
  const konfirmasiDilihat = [];

  const hasil = await jalankanAgent({
    config: configUntuk(tiruan.alamat),
    tugas: "buatkan file halo.txt",
    lokasiState,
    cwd,
    konfirmasi: async (deskripsi) => {
      konfirmasiDilihat.push(deskripsi);
      return true;
    },
  });

  assert.equal(hasil.ok, true);
  assert.equal(hasil.ringkasan, "Selesai: file halo.txt dibuat.");
  assert.equal(hasil.jumlahLangkah, 2);
  assert.equal(fs.readFileSync(path.join(cwd, "halo.txt"), "utf8"), konten);
  assert.equal(konfirmasiDilihat.length, 1, "tulis_file wajib meminta konfirmasi sekali");
  assert.match(konfirmasiDilihat[0], /halo\.txt/);
  // Hasil tool yang dikirim balik ke model harus melaporkan keberhasilan.
  const tool = pesanTool(tiruan.panggilan, 2);
  assert.equal(tool.length, 1);
  assert.match(tool[0].content, /^OK:/);
  assert.equal(tool[0].tool_call_id, "panggilan-1");
  // thought_signature dari penyedia (Gemini 3) harus diteruskan apa adanya pada
  // riwayat panggilan berikutnya — tanpanya Gemini menolak dengan HTTP 400.
  assert.match(tiruan.panggilan[1].body, /TANDA-UJI-123/);
});

test("(i) agent: konfirmasi menolak tulis_file → file tidak tercipta, loop tetap berakhir wajar", async () => {
  const tiruan = await mulaiServer((req, res, body, ke) => {
    if (ke === 1) {
      balasToolCalls(res, [{ nama: "tulis_file", argumen: { path: "gagal.txt", konten: "tidak boleh ada" } }]);
    } else {
      balasTeks(res, "Baik, penulisan dibatalkan.");
    }
  });
  const { cwd, lokasiState } = buatSementara();

  const hasil = await jalankanAgent({
    config: configUntuk(tiruan.alamat),
    tugas: "buatkan file gagal.txt",
    lokasiState,
    cwd,
    konfirmasi: async () => false,
  });

  assert.equal(hasil.ok, true);
  assert.equal(hasil.ringkasan, "Baik, penulisan dibatalkan.");
  assert.equal(fs.existsSync(path.join(cwd, "gagal.txt")), false, "file dari aksi yang ditolak tidak boleh tercipta");
  // Model harus menerima kabar penolakan yang jelas.
  const tool = pesanTool(tiruan.panggilan, 2);
  assert.equal(tool.length, 1);
  assert.match(tool[0].content, /^DITOLAK:/);
});

test("(j) agent: path traversal ../jahat.txt ditolak eksekutor, tidak ada file di luar cwd", async () => {
  const tiruan = await mulaiServer((req, res, body, ke) => {
    if (ke === 1) {
      balasToolCalls(res, [{ nama: "tulis_file", argumen: { path: "../jahat.txt", konten: "jahat" } }]);
    } else {
      balasTeks(res, "Tidak bisa menulis di luar folder kerja.");
    }
  });
  const { dir, cwd, lokasiState } = buatSementara();

  const hasil = await jalankanAgent({
    config: configUntuk(tiruan.alamat),
    tugas: "tulis file di luar folder",
    lokasiState,
    cwd,
    // Konfirmasi menyetujui pun tidak boleh menembus pagar path.
    konfirmasi: async () => true,
  });

  assert.equal(hasil.ok, true);
  assert.equal(fs.existsSync(path.join(dir, "jahat.txt")), false, "file traversal tidak boleh tercipta di luar cwd");
  const tool = pesanTool(tiruan.panggilan, 2);
  assert.equal(tool.length, 1);
  assert.match(tool[0].content, /^ERROR:/);
  assert.match(tool[0].content, /di luar folder kerja/);
});

test("(k) agent: jalankan_perintah yang dikonfirmasi benar-benar berjalan di cwd", async () => {
  const perintah = `node -e "require('fs').writeFileSync('tanda.txt','ok')"`;
  const tiruan = await mulaiServer((req, res, body, ke) => {
    if (ke === 1) {
      balasToolCalls(res, [{ nama: "jalankan_perintah", argumen: { perintah } }]);
    } else {
      balasTeks(res, "Perintah selesai dijalankan.");
    }
  });
  const { cwd, lokasiState } = buatSementara();
  const konfirmasiDilihat = [];

  const hasil = await jalankanAgent({
    config: configUntuk(tiruan.alamat),
    tugas: "buat file tanda lewat perintah",
    lokasiState,
    cwd,
    konfirmasi: async (deskripsi) => {
      konfirmasiDilihat.push(deskripsi);
      return true;
    },
  });

  assert.equal(hasil.ok, true);
  assert.equal(fs.readFileSync(path.join(cwd, "tanda.txt"), "utf8"), "ok");
  assert.equal(konfirmasiDilihat.length, 1, "jalankan_perintah wajib meminta konfirmasi");
  assert.match(konfirmasiDilihat[0], /node -e/);
  const tool = pesanTool(tiruan.panggilan, 2);
  assert.match(tool[0].content, /kode keluar: 0/);
});
