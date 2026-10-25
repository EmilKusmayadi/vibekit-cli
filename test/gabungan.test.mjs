import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { jalankanGiliran, pangkasRiwayatAman } from "../dist/agent.js";
import { hitungToken } from "../dist/token.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibekit-gabungan-test-"));
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

/** Cerminkan cara agent.ts menghitung token satu pesan (konten + argumen tool_calls). */
function tokenPesanUji(m) {
  const teks = (m.content ?? "") + (m.tool_calls?.length ? "\n" + JSON.stringify(m.tool_calls) : "");
  return hitungToken(teks);
}

function totalTokenUji(msgs) {
  return msgs.reduce((s, m) => s + tokenPesanUji(m), 0);
}

/** Aseri struktural: tidak ada pesan tool yang pendahulu sahnya (assistant tool_calls dalam rangkaian yang sama) hilang. */
function assertTidakAdaToolYatim(msgs) {
  const idTerlihat = new Set();
  for (const m of msgs) {
    if (m.role === "user") idTerlihat.clear(); // rangkaian baru dimulai
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) idTerlihat.add(tc.id);
    }
    if (m.role === "tool") {
      assert.ok(
        idTerlihat.has(m.tool_call_id),
        `pesan tool yatim: tool_call_id ${m.tool_call_id} tanpa assistant tool_calls pendahulu dalam rangkaian yang sama`
      );
    }
  }
}

after(() => {
  for (const s of serverBerjalan) s.close();
});

test("(l) gabungan: jalankanGiliran 'buatkan file' → tool jalan, riwayat lengkap, token teragregasi", async () => {
  const konten = "Isi file gabungan.";
  const tiruan = await mulaiServer((req, res, body, ke) => {
    if (ke === 1) {
      balasToolCalls(
        res,
        [{ nama: "tulis_file", argumen: { path: "gabungan.txt", konten }, tandaTangan: "TANDA-GABUNGAN-9" }],
        100
      );
    } else {
      balasTeks(res, "File gabungan.txt selesai dibuat.", 250);
    }
  });
  const { cwd, lokasiState } = buatSementara();
  const messages = [
    { role: "system", content: "prompt sistem uji" },
    { role: "user", content: "buatkan file gabungan.txt" },
  ];
  let jumlahKonfirmasi = 0;

  const hasil = await jalankanGiliran({
    config: configUntuk(tiruan.alamat),
    messages,
    lokasiState,
    cwd,
    konfirmasi: async () => {
      jumlahKonfirmasi++;
      return true;
    },
  });

  assert.equal(hasil.ok, true);
  assert.equal(hasil.jawabanAkhir, "File gabungan.txt selesai dibuat.");
  assert.equal(hasil.jumlahLangkah, 2);
  assert.equal(hasil.totalToken, 350, "totalToken = usage panggilan 1 (100) + panggilan 2 (250)");
  assert.equal(hasil.providerTerakhir?.nama, "tiruan");
  assert.equal(hasil.tokenSumber, "usage");
  assert.equal(fs.readFileSync(path.join(cwd, "gabungan.txt"), "utf8"), konten);
  assert.equal(jumlahKonfirmasi, 1, "tulis_file meminta konfirmasi tepat sekali");

  // Riwayat bertambah utuh: assistant mentah → tool → assistant teks akhir.
  assert.equal(messages.length, 5);
  const [sistem, user, asistenMentah, pesanTool, asistenAkhir] = messages;
  assert.equal(sistem.role, "system");
  assert.equal(user.role, "user");
  assert.equal(asistenMentah.role, "assistant");
  assert.equal(
    asistenMentah.tool_calls[0].extra_content.google.thought_signature,
    "TANDA-GABUNGAN-9",
    "pesan assistant mentah (dengan thought_signature) harus diteruskan apa adanya"
  );
  assert.equal(pesanTool.role, "tool");
  assert.equal(pesanTool.tool_call_id, "panggilan-1");
  assert.match(pesanTool.content, /^OK:/);
  assert.deepEqual(asistenAkhir, { role: "assistant", content: "File gabungan.txt selesai dibuat." });
  // Tanda tangan juga benar-benar terkirim pada panggilan HTTP kedua.
  assert.match(tiruan.panggilan[1].body, /TANDA-GABUNGAN-9/);
});

test("(m) gabungan: jalankanGiliran pertanyaan biasa → teks langsung, tanpa tool, satu langkah", async () => {
  const tiruan = await mulaiServer((req, res) => {
    balasTeks(res, "REST adalah gaya arsitektur untuk API.", 120);
  });
  const { cwd, lokasiState } = buatSementara();
  const messages = [{ role: "user", content: "apa itu REST?" }];
  let jumlahKonfirmasi = 0;

  const hasil = await jalankanGiliran({
    config: configUntuk(tiruan.alamat),
    messages,
    lokasiState,
    cwd,
    konfirmasi: async () => {
      jumlahKonfirmasi++;
      return true;
    },
  });

  assert.equal(hasil.ok, true);
  assert.equal(hasil.jawabanAkhir, "REST adalah gaya arsitektur untuk API.");
  assert.equal(hasil.jumlahLangkah, 1);
  assert.equal(hasil.totalToken, 120);
  assert.equal(hasil.providerTerakhir?.nama, "tiruan");
  assert.equal(jumlahKonfirmasi, 0, "pertanyaan biasa tidak boleh memicu konfirmasi apa pun");
  assert.equal(tiruan.panggilan.length, 1, "hanya satu panggilan model");
  assert.equal(messages.length, 2, "riwayat hanya bertambah pesan assistant teks");
  assert.deepEqual(messages[1], { role: "assistant", content: "REST adalah gaya arsitektur untuk API." });
  assert.equal(messages.some((m) => m.role === "tool"), false, "tidak ada pesan tool");
  assert.equal(fs.readdirSync(cwd).length, 0, "tidak ada file yang dibuat");
});

function buatGiliranTool(id, kata, jumlahUlang) {
  return [
    { role: "user", content: `permintaan ${kata} ` + `${kata} `.repeat(jumlahUlang) },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id,
          type: "function",
          function: {
            name: "tulis_file",
            arguments: JSON.stringify({ path: `${kata}.txt`, konten: "isi ".repeat(jumlahUlang) }),
          },
        },
      ],
    },
    { role: "tool", tool_call_id: id, name: "tulis_file", content: "OK: " + "hasil ".repeat(jumlahUlang) },
    { role: "assistant", content: `selesai giliran ${kata} ` + "ya ".repeat(Math.floor(jumlahUlang / 2)) },
  ];
}

test("(n) gabungan: pangkasRiwayatAman memotong hanya pada batas giliran utuh, tanpa tool yatim", () => {
  const giliranA = buatGiliranTool("panggilan-A1", "pertama", 40);
  const giliranB = buatGiliranTool("panggilan-B1", "kedua", 40);
  const giliranC = [
    { role: "user", content: "permintaan terakhir singkat" },
    { role: "assistant", content: "jawaban terakhir singkat" },
  ];
  const riwayat = [...giliranA, ...giliranB, ...giliranC];
  const panjangAsli = riwayat.length;
  const tokenB = totalTokenUji(giliranB);
  const tokenC = totalTokenUji(giliranC);
  assert.ok(totalTokenUji(giliranA) > 5, "prasyarat: giliran A cukup besar untuk memaksa pemotongan");

  // Skenario 1: batas cukup untuk B + C → hanya A yang dibuang, rangkaian tool B utuh.
  const maks1 = tokenB + tokenC + 5;
  const hasil1 = pangkasRiwayatAman(riwayat, maks1);
  assert.equal(hasil1[0].role, "user");
  assert.equal(hasil1[0].content, giliranB[0].content, "giliran tertua (A) dibuang, B menjadi awal");
  assert.equal(hasil1.length, giliranB.length + giliranC.length);
  assertTidakAdaToolYatim(hasil1);
  assert.ok(totalTokenUji(hasil1) <= maks1, "total token hasil pangkas ≤ batas");
  assert.deepEqual(hasil1.slice(-giliranC.length), giliranC, "giliran terakhir utuh");

  // Skenario 2: batas sangat ketat → hanya tersisa satu giliran utuh terakhir.
  const hasil2 = pangkasRiwayatAman(riwayat, tokenC + 2);
  assert.equal(hasil2.length, giliranC.length);
  assert.equal(hasil2[0].role, "user");
  assert.deepEqual(hasil2, giliranC);
  assertTidakAdaToolYatim(hasil2);

  // Array masukan tidak diubah fungsi.
  assert.equal(riwayat.length, panjangAsli);
});

test("(n2) gabungan: pangkasRiwayatAman mempertahankan awalan system dan tidak memangkas bila sudah muat", () => {
  const sistem = { role: "system", content: "prompt sistem gabungan" };
  const giliran = buatGiliranTool("panggilan-S1", "sistem", 10);
  const riwayat = [sistem, ...giliran];

  // Batas longgar: tidak ada yang dibuang.
  const utuh = pangkasRiwayatAman(riwayat, 100000);
  assert.equal(utuh.length, riwayat.length);
  assert.deepEqual(utuh[0], sistem);

  // Batas ketat: system tetap dipertahankan, sesudahnya giliran utuh terakhir.
  const giliranTerakhir = [
    { role: "user", content: "halo terakhir" },
    { role: "assistant", content: "halo juga" },
  ];
  const riwayat2 = [sistem, ...giliran, ...giliranTerakhir];
  const hasil = pangkasRiwayatAman(riwayat2, totalTokenUji(giliranTerakhir) + tokenPesanUji(sistem) + 2);
  assert.equal(hasil[0].role, "system");
  assert.equal(hasil[1].role, "user");
  assert.deepEqual(hasil.slice(1), giliranTerakhir);
  assertTidakAdaToolYatim(hasil);
});
