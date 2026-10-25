import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { jalankanGiliran, kompaksiRiwayatAksi } from "../dist/agent.js";

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
            })),
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: totalToken - 50, total_tokens: totalToken },
    })
  );
}

function buatSementara() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibekit-v040-test-"));
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

after(() => {
  for (const s of serverBerjalan) s.close();
});

test("(o) v0.4.0: autoAllow menjalankan tulis_file TANPA memanggil konfirmasi sama sekali", async () => {
  const tiruan = await mulaiServer((req, res, body, ke) => {
    if (ke === 1) {
      balasToolCalls(res, [{ nama: "tulis_file", argumen: { path: "auto.txt", konten: "dibuat otomatis" } }]);
    } else {
      balasTeks(res, "File auto.txt selesai dibuat.");
    }
  });
  const { cwd, lokasiState } = buatSementara();
  let konfirmasiDipanggil = 0;
  const jejakTerekam = [];

  const hasil = await jalankanGiliran({
    config: configUntuk(tiruan.alamat),
    messages: [{ role: "user", content: "buatkan file auto.txt" }],
    lokasiState,
    cwd,
    autoAllow: true,
    konfirmasi: async () => {
      konfirmasiDipanggil++;
      throw new Error("konfirmasi TIDAK BOLEH dipanggil dalam mode auto-allow");
    },
    jejak: (pesan) => jejakTerekam.push(pesan),
  });

  assert.equal(hasil.ok, true);
  assert.equal(hasil.jawabanAkhir, "File auto.txt selesai dibuat.");
  assert.equal(fs.readFileSync(path.join(cwd, "auto.txt"), "utf8"), "dibuat otomatis");
  assert.equal(konfirmasiDipanggil, 0, "callback konfirmasi tidak boleh dipanggil sekali pun saat autoAllow");
  assert.ok(
    jejakTerekam.some((j) => j.includes("tulis_file") && j.includes("(auto)")),
    "jejak langkah tool mutasi harus memuat penanda (auto)"
  );
});

test("(p) v0.4.0: kompaksiRiwayatAksi memadatkan giliran lama jadi ringkasan, giliran terakhir utuh", () => {
  const kontenFile = "<html><body>isi rahasia yang panjang sekali</body></html>";
  const giliran1 = [
    { role: "user", content: "buatkan file index.html hello world" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "panggilan-1",
          type: "function",
          function: { name: "tulis_file", arguments: JSON.stringify({ path: "index.html", konten: kontenFile }) },
          extra_content: { google: { thought_signature: "TANDA-X" } },
        },
      ],
    },
    { role: "tool", tool_call_id: "panggilan-1", name: "tulis_file", content: "OK: file index.html ditulis (228 karakter)." },
    { role: "assistant", content: "File index.html selesai dibuat." },
  ];
  const giliran2 = [
    { role: "user", content: "apa itu REST?" },
    { role: "assistant", content: "REST adalah gaya arsitektur API." },
  ];
  const riwayat = [...giliran1, ...giliran2];
  const salinanMasukan = JSON.parse(JSON.stringify(riwayat));

  const hasil = kompaksiRiwayatAksi(riwayat);
  const teksHasil = JSON.stringify(hasil);

  // Tanda tangan & argumen konten file dari giliran lama harus lenyap.
  assert.ok(!teksHasil.includes("TANDA-X"), "thought_signature giliran lama harus terbuang");
  assert.ok(!teksHasil.includes("isi rahasia"), "argumen konten file tidak boleh ikut terbawa");

  // Ada pesan ringkasan yang menyebut tool & targetnya.
  const ringkasan = hasil.find(
    (m) => m.role === "assistant" && typeof m.content === "string" && m.content.startsWith("[Aksi selesai:")
  );
  assert.ok(ringkasan, "harus ada pesan ringkasan [Aksi selesai: ...]");
  assert.ok(ringkasan.content.includes("tulis_file"), "ringkasan menyebut nama tool");
  assert.ok(ringkasan.content.includes("index.html"), "ringkasan menyebut target file");
  assert.ok(ringkasan.content.includes("OK"), "ringkasan menyebut status hasil tool");

  // Tidak ada lagi pesan role "tool" pada giliran pertama hasil kompaksi.
  const idxUserKedua = hasil.findIndex((m, i) => i > 0 && m.role === "user");
  assert.ok(idxUserKedua > 0, "giliran kedua harus masih ada");
  assert.equal(
    hasil.slice(0, idxUserKedua).some((m) => m.role === "tool"),
    false,
    "giliran pertama hasil tidak boleh menyisakan pesan tool"
  );
  // Pesan user & teks assistant penutup giliran pertama dipertahankan.
  assert.equal(hasil[0].content, giliran1[0].content);
  assert.ok(hasil.some((m) => m.content === "File index.html selesai dibuat."));

  // Giliran terakhir persis seperti masukan.
  assert.deepEqual(hasil.slice(idxUserKedua), giliran2);

  // Array masukan tidak berubah.
  assert.deepEqual(riwayat, salinanMasukan);
});

test("(q) v0.4.0: kompaksiRiwayatAksi TIDAK menyentuh giliran terakhir sama sekali", () => {
  const riwayat = [
    { role: "system", content: "prompt sistem uji" },
    { role: "user", content: "buatkan file tunggal.txt" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "panggilan-1",
          type: "function",
          function: { name: "tulis_file", arguments: JSON.stringify({ path: "tunggal.txt", konten: "isi tunggal" }) },
          extra_content: { google: { thought_signature: "TANDA-TUNGGAL" } },
        },
      ],
    },
    { role: "tool", tool_call_id: "panggilan-1", name: "tulis_file", content: "OK: file tunggal.txt ditulis (11 karakter)." },
    { role: "assistant", content: "Selesai." },
  ];
  const salinanMasukan = JSON.parse(JSON.stringify(riwayat));

  const hasil = kompaksiRiwayatAksi(riwayat);

  assert.deepEqual(hasil, salinanMasukan, "satu-satunya giliran adalah giliran terakhir → hasil identik masukan");
  assert.ok(JSON.stringify(hasil).includes("TANDA-TUNGGAL"), "tanda tangan giliran terakhir tetap utuh");
  assert.deepEqual(riwayat, salinanMasukan, "array masukan tidak berubah");
});
