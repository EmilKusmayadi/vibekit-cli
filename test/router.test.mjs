import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { tanyaRouter } from "../dist/router.js";
import { muatState, statePenyedia, tanggalLokal } from "../dist/state.js";

const serverBerjalan = [];

function mulaiServer(penangan) {
  return new Promise((resolve) => {
    const panggilan = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        panggilan.push({ url: req.url, body });
        penangan(req, res, body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const alamat = `http://127.0.0.1:${server.address().port}/v1`;
      serverBerjalan.push(server);
      resolve({ server, panggilan, alamat });
    });
  });
}

function balasChat(res, konten, totalToken) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: konten } }],
      usage: { prompt_tokens: Math.ceil(totalToken / 2), completion_tokens: totalToken - Math.ceil(totalToken / 2), total_tokens: totalToken },
    })
  );
}

function balasError(res, status, objek) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(objek));
}

function buatSementara() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibekit-test-"));
  return { dir, lokasiState: path.join(dir, "state.json") };
}

function penyedia(nama, baseUrl, tambahan = {}) {
  return { nama, baseUrl, apiKey: "kunci-uji", model: `model-${nama}`, jedaCooldownMenit: 15, ...tambahan };
}

const GAYA = { gaya: { jawaban: "poin-penting", maksTokenJawaban: 800 } };
const PESAN = [{ role: "user", content: "halo, apa itu API?" }];

after(() => {
  for (const s of serverBerjalan) s.close();
});

test("(a) penyedia pertama 429 kuota → jawaban dari penyedia kedua, pertama ditandai cooldown", async () => {
  const pertama = await mulaiServer((req, res) =>
    balasError(res, 429, { error: { code: "insufficient_quota", message: "You exceeded your current quota" } })
  );
  const kedua = await mulaiServer((req, res) => balasChat(res, "API adalah antarmuka pemrograman.", 321));
  const { lokasiState } = buatSementara();

  const hasil = await tanyaRouter({
    config: { providers: [penyedia("pertama", pertama.alamat), penyedia("kedua", kedua.alamat)], ...GAYA },
    messages: PESAN,
    lokasiState,
  });

  assert.equal(hasil.ok, true);
  assert.equal(hasil.provider.nama, "kedua");
  assert.equal(hasil.jawaban, "API adalah antarmuka pemrograman.");
  assert.equal(pertama.panggilan.length, 1);
  assert.equal(kedua.panggilan.length, 1);

  const state = muatState(lokasiState);
  const entriPertama = statePenyedia(state, "pertama");
  assert.ok(entriPertama.cooldownUntil, "penyedia pertama harus cooldown");
  assert.match(entriPertama.alasanTerakhir ?? "", /kuota/i);
  // Cooldown kuota = sampai akhir hari lokal (jam 23:59).
  assert.equal(new Date(entriPertama.cooldownUntil).getHours(), 23);
  assert.equal(new Date(entriPertama.cooldownUntil).getMinutes(), 59);
});

test("(a2) penyedia yang sedang cooldown dilewati tanpa dipanggil pada permintaan berikutnya", async () => {
  const pertama = await mulaiServer((req, res) =>
    balasError(res, 429, { error: { code: "insufficient_quota", message: "quota exceeded" } })
  );
  const kedua = await mulaiServer((req, res) => balasChat(res, "jawaban kedua", 100));
  const { lokasiState } = buatSementara();
  const config = { providers: [penyedia("pertama", pertama.alamat), penyedia("kedua", kedua.alamat)], ...GAYA };

  await tanyaRouter({ config, messages: PESAN, lokasiState });
  const panggilanSebelum = pertama.panggilan.length;
  const hasil2 = await tanyaRouter({ config, messages: PESAN, lokasiState });

  assert.equal(hasil2.ok, true);
  assert.equal(hasil2.provider.nama, "kedua");
  assert.equal(pertama.panggilan.length, panggilanSebelum, "penyedia cooldown tidak boleh dipanggil lagi");
});

test("(b) penyedia dengan anggaran harian tercapai dilewati tanpa dipanggil sama sekali", async () => {
  const hemat = await mulaiServer((req, res) => balasChat(res, "tidak boleh terpanggil", 1));
  const cadangan = await mulaiServer((req, res) => balasChat(res, "jawaban cadangan", 50));
  const { lokasiState } = buatSementara();

  // Tanam state: penyedia "hemat" sudah memakai 150 token hari ini, anggaran 100.
  const stateAwal = {
    providers: {
      hemat: { tanggal: tanggalLokal(), totalToken: 150, cooldownUntil: null, alasanTerakhir: null },
    },
  };
  fs.writeFileSync(lokasiState, JSON.stringify(stateAwal));

  const hasil = await tanyaRouter({
    config: {
      providers: [
        penyedia("hemat", hemat.alamat, { anggaranHarian: 100 }),
        penyedia("cadangan", cadangan.alamat),
      ],
      ...GAYA,
    },
    messages: PESAN,
    lokasiState,
  });

  assert.equal(hasil.ok, true);
  assert.equal(hasil.provider.nama, "cadangan");
  assert.equal(hemat.panggilan.length, 0, "server penyedia beranggaran tercapai tidak boleh menerima panggilan");
  assert.equal(cadangan.panggilan.length, 1);
});

test("(c) usage dari respons tercatat ke state setelah sukses", async () => {
  const satu = await mulaiServer((req, res) => balasChat(res, "jawaban", 777));
  const { lokasiState } = buatSementara();

  const hasil = await tanyaRouter({
    config: { providers: [penyedia("satu", satu.alamat)], ...GAYA },
    messages: PESAN,
    lokasiState,
  });

  assert.equal(hasil.ok, true);
  assert.equal(hasil.tokenTerpakai, 777);
  assert.equal(hasil.tokenSumber, "usage");
  const state = muatState(lokasiState);
  assert.equal(statePenyedia(state, "satu").totalToken, 777);
});

test("(c2) tanpa field usage → token diestimasi tokenizer dan tetap tercatat", async () => {
  const polos = await mulaiServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "jawaban tanpa usage" } }] }));
  });
  const { lokasiState } = buatSementara();

  const hasil = await tanyaRouter({
    config: { providers: [penyedia("polos", polos.alamat)], ...GAYA },
    messages: PESAN,
    lokasiState,
  });

  assert.equal(hasil.ok, true);
  assert.equal(hasil.tokenSumber, "estimasi");
  assert.ok(hasil.tokenTerpakai > 0);
  const state = muatState(lokasiState);
  assert.equal(statePenyedia(state, "polos").totalToken, hasil.tokenTerpakai);
});

test("(d) semua penyedia habis → pesan gagal informatif berisi status tiap penyedia", async () => {
  const kuota = await mulaiServer((req, res) =>
    balasError(res, 429, { error: { code: "insufficient_quota", message: "quota exceeded" } })
  );
  const saldo = await mulaiServer((req, res) =>
    balasError(res, 402, { error: { message: "Insufficient balance" } })
  );
  const { lokasiState } = buatSementara();

  const hasil = await tanyaRouter({
    config: { providers: [penyedia("kuota", kuota.alamat), penyedia("saldo", saldo.alamat)], ...GAYA },
    messages: PESAN,
    lokasiState,
  });

  assert.equal(hasil.ok, false);
  assert.match(hasil.pesan, /kuota/);
  assert.match(hasil.pesan, /saldo/);
  assert.match(hasil.pesan, /bisa dicoba lagi/);
});

test("(e) error 401 (kunci salah) tidak dianggap kuota habis: tanpa cooldown, tetap lanjut ke berikutnya", async () => {
  const salah = await mulaiServer((req, res) =>
    balasError(res, 401, { error: { message: "Incorrect API key provided" } })
  );
  const benar = await mulaiServer((req, res) => balasChat(res, "jawaban benar", 42));
  const { lokasiState } = buatSementara();

  const hasil = await tanyaRouter({
    config: { providers: [penyedia("salah", salah.alamat), penyedia("benar", benar.alamat)], ...GAYA },
    messages: PESAN,
    lokasiState,
  });

  assert.equal(hasil.ok, true);
  assert.equal(hasil.provider.nama, "benar");
  const state = muatState(lokasiState);
  const entriSalah = statePenyedia(state, "salah");
  assert.equal(entriSalah.cooldownUntil, null, "401 tidak boleh memicu cooldown kuota");
  assert.match(entriSalah.alasanTerakhir ?? "", /401/);
});

test("(f) system prompt hemat + max_tokens dari gaya terkirim ke penyedia", async () => {
  const perekam = await mulaiServer((req, res) => balasChat(res, "ok", 10));
  const { lokasiState } = buatSementara();

  await tanyaRouter({
    config: { providers: [penyedia("perekam", perekam.alamat)], gaya: { jawaban: "poin-penting", maksTokenJawaban: 321 } },
    messages: PESAN,
    lokasiState,
  });

  const body = JSON.parse(perekam.panggilan[0].body);
  assert.equal(body.max_tokens, 321);
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /poin-poin penting/i);
});
