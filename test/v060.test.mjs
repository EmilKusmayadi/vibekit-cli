import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { jalankanAgentRencana, kompaksiRiwayatAksi, kompaksiRiwayatAksiTerukur } from "../dist/agent.js";
import { buatBrief, muatKonteksBrief } from "../dist/brief.js";
import { tanyaRouter } from "../dist/router.js";
import { daftarSesi, folderSesi, muatSesiTerakhir, simpanSesi } from "../dist/sesi.js";
import { bangunLaporanHemat, muatState, tanggalLokal, tanggalTerakhir } from "../dist/state.js";

const AKAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

function balasChat(res, konten, totalToken = 100) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: konten } }],
      usage: { prompt_tokens: 50, completion_tokens: totalToken - 50, total_tokens: totalToken },
    })
  );
}

function balasError(res, status, objek) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(objek));
}

/** Balas SSE: deretan objek chunk, ditutup [DONE]. */
function balasSSE(res, daftarChunk) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const c of daftarChunk) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const chunkTeks = (teks) => ({ choices: [{ delta: { content: teks } }] });
const chunkUsage = (total) => ({
  choices: [],
  usage: { prompt_tokens: 40, completion_tokens: total - 40, total_tokens: total },
});

function buatSementara() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibekit-v060-test-"));
  const cwd = path.join(dir, "kerja");
  fs.mkdirSync(cwd);
  return { dir, cwd, lokasiState: path.join(dir, "state.json") };
}

function penyedia(nama, baseUrl, tambahan = {}) {
  return { nama, baseUrl, apiKey: "kunci-uji", model: `model-${nama}`, jedaCooldownMenit: 15, ...tambahan };
}

const GAYA = { jawaban: "poin-penting", maksTokenJawaban: 800 };

function jalankanCli(argumen, { cwd, env = {}, masukan = "" }) {
  return new Promise((resolve, reject) => {
    const anak = spawn(process.execPath, [path.join(AKAR, "dist", "cli.js"), ...argumen], {
      cwd,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    anak.stdout.on("data", (d) => (stdout += d));
    anak.stderr.on("data", (d) => (stderr += d));
    const pengatur = setTimeout(() => {
      anak.kill("SIGKILL");
      reject(new Error(`CLI timeout: ${argumen.join(" ")}`));
    }, 30000);
    anak.on("error", (e) => {
      clearTimeout(pengatur);
      reject(e);
    });
    anak.on("close", (kode) => {
      clearTimeout(pengatur);
      resolve({ kode, stdout, stderr });
    });
    anak.stdin.write(masukan);
    anak.stdin.end();
  });
}

after(() => {
  for (const s of serverBerjalan) s.close();
});

// ---------- Fitur 1: vibekit hemat ----------

test("(v60-a) hemat: kompaksi terukur melaporkan tokenTerbuang > 0 untuk riwayat berisi isi file besar", () => {
  const kontenBesar = "Baris isi file yang sangat panjang dan berulang. ".repeat(120);
  const riwayat = [
    { role: "user", content: "buatkan file besar.txt" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "p-1",
          type: "function",
          function: { name: "tulis_file", arguments: JSON.stringify({ path: "besar.txt", konten: kontenBesar }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "p-1", name: "tulis_file", content: `OK: isi ditulis.\n${kontenBesar}` },
    { role: "assistant", content: "Selesai." },
    { role: "user", content: "pertanyaan berikutnya" },
    { role: "assistant", content: "jawaban berikutnya" },
  ];
  const hasil = kompaksiRiwayatAksiTerukur(riwayat);
  assert.ok(hasil.tokenTerbuang > 100, `tokenTerbuang harus besar, dapat ${hasil.tokenTerbuang}`);
  // Hasil riwayat identik dengan fungsi kompaksi biasa.
  assert.deepEqual(hasil.riwayat, kompaksiRiwayatAksi(riwayat));
});

test("(v60-b) hemat: laporan memuat total per provider, format id-ID, dan catatan kejujuran", () => {
  const sekarang = new Date();
  const hari = tanggalTerakhir(7, sekarang);
  const state = {
    providers: {},
    pemakaianHarian: {
      [hari[0]]: { gemini: 1500, gpt: 250 },
      [hari[3]]: { gemini: 2000 },
    },
    hematKompaksi: { [hari[0]]: 300, [hari[3]]: 700 },
  };
  const laporan = bangunLaporanHemat(state, sekarang);
  assert.match(laporan, /gemini: 1\.500 token/);
  assert.match(laporan, /gpt: 250 token/);
  assert.match(laporan, /Total hari ini: 1\.750 token/);
  assert.match(laporan, /gemini \(7 hari\): 3\.500 token/);
  assert.match(laporan, /Total 7 hari terakhir: 3\.750 token/);
  assert.match(laporan, /Hari ini: 300 token/);
  assert.match(laporan, /Total tercatat: 1\.000 token/);
  assert.match(laporan, /bersifat desain/);
});

test("(v60-c) hemat: router mencatat pemakaianHarian per provider saat sukses", async () => {
  const satu = await mulaiServer((req, res) => balasChat(res, "jawaban tercatat", 777));
  const { lokasiState } = buatSementara();
  const hasil = await tanyaRouter({
    config: { providers: [penyedia("satu", satu.alamat)], gaya: GAYA },
    messages: [{ role: "user", content: "halo" }],
    lokasiState,
  });
  assert.equal(hasil.ok, true);
  const state = muatState(lokasiState);
  assert.equal(state.pemakaianHarian?.[tanggalLokal()]?.satu, 777);
});

// ---------- Fitur 2: streaming ----------

test("(v60-d) streaming teks: potongan terakumulasi benar, onToken & usage tercatat", async () => {
  const srv = await mulaiServer((req, res) =>
    balasSSE(res, [chunkTeks("Halo"), chunkTeks(", dunia"), chunkTeks("!"), chunkUsage(99)])
  );
  const { lokasiState } = buatSementara();
  const potongan = [];
  let tokenPertama = 0;
  const hasil = await tanyaRouter({
    config: { providers: [penyedia("alir", srv.alamat)], gaya: GAYA },
    messages: [{ role: "user", content: "sapa saya" }],
    lokasiState,
    stream: true,
    onToken: (p) => potongan.push(p),
    onTokenPertama: () => tokenPertama++,
  });
  assert.equal(hasil.ok, true);
  assert.equal(hasil.jawaban, "Halo, dunia!");
  assert.deepEqual(potongan, ["Halo", ", dunia", "!"]);
  assert.equal(tokenPertama, 1);
  assert.equal(hasil.tokenTerpakai, 99);
  assert.equal(hasil.tokenSumber, "usage");
  const body = JSON.parse(srv.panggilan[0].body);
  assert.equal(body.stream, true);
  assert.equal(body.stream_options.include_usage, true);
  const state = muatState(lokasiState);
  assert.equal(state.providers.alir.totalToken, 99);
});

test("(v60-e) streaming tool_calls: delta terpotong terakit utuh termasuk extra_content di pesanMentah", async () => {
  const srv = await mulaiServer((req, res) =>
    balasSSE(res, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "p-1", type: "function", function: { name: "tulis_file", arguments: "{\"path\":\"a.txt\"," } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: "\"konten\":\"halo\"}" },
                  extra_content: { google: { thought_signature: "TANDA-STREAM" } },
                },
              ],
            },
          },
        ],
      },
      chunkUsage(42),
    ])
  );
  const { lokasiState } = buatSementara();
  const hasil = await tanyaRouter({
    config: { providers: [penyedia("alir", srv.alamat)], gaya: GAYA },
    messages: [{ role: "user", content: "buatkan a.txt" }],
    lokasiState,
    stream: true,
    tools: [
      {
        type: "function",
        function: { name: "tulis_file", description: "tulis", parameters: { type: "object", properties: {} } },
      },
    ],
  });
  assert.equal(hasil.ok, true);
  assert.equal(hasil.toolCalls.length, 1);
  assert.equal(hasil.toolCalls[0].function.name, "tulis_file");
  assert.deepEqual(JSON.parse(hasil.toolCalls[0].function.arguments), { path: "a.txt", konten: "halo" });
  assert.equal(hasil.pesanMentah.tool_calls[0].extra_content.google.thought_signature, "TANDA-STREAM");
  assert.equal(hasil.tokenTerpakai, 42);
});

test("(v60-f) streaming: error 429 SEBELUM aliran → failover ke penyedia kedua yang streaming", async () => {
  const pertama = await mulaiServer((req, res) =>
    balasError(res, 429, { error: { code: "insufficient_quota", message: "quota exceeded" } })
  );
  const kedua = await mulaiServer((req, res) => balasSSE(res, [chunkTeks("dari kedua"), chunkUsage(10)]));
  const { lokasiState } = buatSementara();
  const hasil = await tanyaRouter({
    config: { providers: [penyedia("pertama", pertama.alamat), penyedia("kedua", kedua.alamat)], gaya: GAYA },
    messages: [{ role: "user", content: "halo" }],
    lokasiState,
    stream: true,
  });
  assert.equal(hasil.ok, true);
  assert.equal(hasil.provider.nama, "kedua");
  assert.equal(hasil.jawaban, "dari kedua");
  assert.equal(kedua.panggilan.length, 1);
});

test("(v60-g) streaming: aliran putus di TENGAH → TIDAK failover, streamTerputus true", async () => {
  const menggantung = await mulaiServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(chunkTeks("Halo sebagian"))}\n\n`);
    // Sengaja tidak pernah diakhiri: router harus menyerah lewat timeout alirannya.
  });
  const kedua = await mulaiServer((req, res) => balasSSE(res, [chunkTeks("tidak boleh terpanggil")]));
  const { lokasiState } = buatSementara();
  const potongan = [];
  const hasil = await tanyaRouter({
    config: { providers: [penyedia("gantung", menggantung.alamat), penyedia("kedua", kedua.alamat)], gaya: GAYA },
    messages: [{ role: "user", content: "halo" }],
    lokasiState,
    stream: true,
    timeoutMs: 400,
    onToken: (p) => potongan.push(p),
  });
  assert.equal(hasil.ok, false);
  assert.equal(hasil.streamTerputus, true);
  assert.deepEqual(potongan, ["Halo sebagian"]);
  assert.equal(kedua.panggilan.length, 0, "penyedia kedua TIDAK boleh dipanggil setelah token keluar");
});

// ---------- Fitur 3: mode rencana ----------

function serverRencana() {
  return mulaiServer((req, res, body, ke) => {
    const parsed = JSON.parse(body);
    if (!parsed.tools) {
      // Panggilan penyusunan rencana (tanpa tools).
      balasChat(res, "1. Buat file penanda.txt\n2. Laporkan selesai", 50);
    } else if (ke === 2) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "p-1",
                    type: "function",
                    function: { name: "tulis_file", arguments: JSON.stringify({ path: "penanda.txt", konten: "isi penanda" }) },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        })
      );
    } else {
      balasChat(res, "Rencana selesai dijalankan.", 30);
    }
  });
}

test("(v60-h) rencana ditolak → tidak ada eksekusi tool sama sekali", async () => {
  const srv = await serverRencana();
  const { cwd, lokasiState } = buatSementara();
  let panggilanKonfirmasiRencana = 0;
  const hasil = await jalankanAgentRencana({
    config: { providers: [penyedia("tiruan", srv.alamat)], gaya: GAYA },
    tugas: "buatkan file penanda.txt",
    lokasiState,
    cwd,
    konfirmasi: async () => {
      throw new Error("konfirmasi per aksi tidak relevan di tahap rencana");
    },
    konfirmasiRencana: async (rencana) => {
      panggilanKonfirmasiRencana++;
      assert.match(rencana, /penanda\.txt/);
      return false;
    },
  });
  assert.equal(hasil.status, "dibatalkan");
  assert.equal(panggilanKonfirmasiRencana, 1);
  assert.equal(srv.panggilan.length, 1, "hanya panggilan penyusunan rencana yang boleh terjadi");
  assert.equal(fs.existsSync(path.join(cwd, "penanda.txt")), false, "file penanda TIDAK boleh tercipta");
});

test("(v60-i) rencana diterima → tool tereksekusi TANPA konfirmasi per aksi tambahan", async () => {
  const srv = await serverRencana();
  const { cwd, lokasiState } = buatSementara();
  let konfirmasiPerAksi = 0;
  const hasil = await jalankanAgentRencana({
    config: { providers: [penyedia("tiruan", srv.alamat)], gaya: GAYA },
    tugas: "buatkan file penanda.txt",
    lokasiState,
    cwd,
    konfirmasi: async () => {
      konfirmasiPerAksi++;
      return false; // bila sampai terpanggil dan menolak, file tidak akan tercipta
    },
    konfirmasiRencana: async () => true,
  });
  assert.equal(hasil.status, "selesai");
  assert.equal(fs.readFileSync(path.join(cwd, "penanda.txt"), "utf8"), "isi penanda");
  assert.equal(konfirmasiPerAksi, 0, "persetujuan rencana menggantikan konfirmasi per aksi");
});

// ---------- Fitur 4: sesi chat ----------

test("(v60-j) sesi: simpan + muat round-trip utuh termasuk extra_content pada tool_calls", () => {
  const { dir } = buatSementara();
  const dirSesi = folderSesi(dir);
  const pesan = [
    { role: "system", content: "prompt sistem" },
    { role: "user", content: "buatkan file x.txt" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "p-1",
          type: "function",
          function: { name: "tulis_file", arguments: "{\"path\":\"x.txt\",\"konten\":\"isi\"}" },
          extra_content: { google: { thought_signature: "TANDA-SESI" } },
        },
      ],
    },
    { role: "tool", tool_call_id: "p-1", name: "tulis_file", content: "OK: file x.txt ditulis." },
    { role: "assistant", content: "Selesai." },
  ];
  const sesi = { id: "sesi-uji-1", dibuat: "2026-10-26T00:00:00.000Z", diperbarui: "2026-10-26T00:01:00.000Z", pesan };
  simpanSesi(dirSesi, sesi);
  const dimuat = muatSesiTerakhir(dirSesi);
  assert.ok(dimuat, "sesi terakhir harus termuat");
  assert.deepEqual(dimuat.pesan, pesan);
  assert.equal(dimuat.pesan[2].tool_calls[0].extra_content.google.thought_signature, "TANDA-SESI");
  const daftar = daftarSesi(dirSesi);
  assert.equal(daftar.length, 1);
  assert.equal(daftar[0].id, "sesi-uji-1");
  assert.equal(daftar[0].jumlahPesan, 5);
  assert.match(daftar[0].cuplikan, /buatkan file x\.txt/);
});

test("(v60-k) sesi CLI: chat menyimpan sesi, --lanjut memulihkan riwayat ke penyedia, `sesi` mendaftar", async () => {
  const srv = await mulaiServer((req, res, body) => {
    const parsed = JSON.parse(body);
    if (parsed.stream) {
      balasSSE(res, [chunkTeks("JAWABAN-KHAS"), chunkUsage(20)]);
    } else {
      balasChat(res, "JAWABAN-KHAS", 20);
    }
  });
  const { dir, cwd } = buatSementara();
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "vibekit.config.json"),
    JSON.stringify({
      providers: [{ nama: "tiruan", baseUrl: srv.alamat, apiKey: "kunci-uji", model: "model-tiruan" }],
      gaya: GAYA,
    })
  );
  const env = { HOME: home };

  const jalan1 = await jalankanCli(["chat"], { cwd, env, masukan: "halo sesi pertama\n/keluar\n" });
  assert.equal(jalan1.kode, 0, jalan1.stderr);
  const dirSesi = path.join(home, ".vibekit", "sesi");
  assert.ok(fs.existsSync(dirSesi), "folder sesi harus tercipta setelah chat berhasil");
  const berkasSesi = fs.readdirSync(dirSesi).filter((n) => n.startsWith("sesi-"));
  assert.equal(berkasSesi.length, 1);

  const panggilanSebelum = srv.panggilan.length;
  const jalan2 = await jalankanCli(["chat", "--lanjut"], { cwd, env, masukan: "pesan kedua\n/keluar\n" });
  assert.equal(jalan2.kode, 0, jalan2.stderr);
  assert.match(jalan2.stdout, /Sesi dilanjutkan/);
  const bodyLanjutan = JSON.parse(srv.panggilan[panggilanSebelum].body);
  const teksPesan = JSON.stringify(bodyLanjutan.messages);
  assert.match(teksPesan, /halo sesi pertama/, "riwayat lama harus ikut terkirim pada sesi lanjutan");
  assert.match(teksPesan, /JAWABAN-KHAS/, "jawaban assistant lama harus ikut terkirim");
  assert.match(teksPesan, /pesan kedua/);

  const daftar = await jalankanCli(["sesi"], { cwd, env });
  assert.equal(daftar.kode, 0);
  assert.match(daftar.stdout, /Sesi chat tersimpan \(1\)/);
  assert.match(daftar.stdout, /halo sesi pertama/);
});

// ---------- Fitur 5: brief proyek ----------

test("(v60-l) brief: fixture proyek menghasilkan brief.md berisi nama paket & stack terdeteksi", () => {
  const { cwd } = buatSementara();
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({
      name: "proyek-uji",
      version: "1.2.3",
      dependencies: { express: "^4.19.0" },
      devDependencies: { typescript: "^5.6.0" },
      scripts: { start: "node dist/index.js", build: "tsc" },
    })
  );
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "index.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "# Proyek Uji\n\nIni proyek untuk pengujian brief.\n");
  fs.writeFileSync(path.join(cwd, "tsconfig.json"), "{}\n");
  fs.writeFileSync(path.join(cwd, ".env"), "RAHASIA=tidak-boleh-muncul\n");
  fs.writeFileSync(path.join(cwd, ".env.example"), "RAHASIA=\n");

  const hasil = buatBrief(cwd);
  assert.ok(fs.existsSync(hasil.lokasi));
  assert.match(hasil.isi, /proyek-uji/);
  assert.match(hasil.isi, /Express/);
  assert.match(hasil.isi, /TypeScript/);
  assert.match(hasil.isi, /express@/);
  assert.match(hasil.isi, /Proyek Uji/);
  assert.match(hasil.isi, /tsconfig\.json/);
  assert.match(hasil.isi, /\.env\.example/);
  assert.ok(!hasil.isi.includes("tidak-boleh-muncul"), "isi .env asli TIDAK boleh masuk brief");
  assert.ok(hasil.token > 0);
  const konteks = muatKonteksBrief(cwd);
  assert.ok(konteks);
  assert.match(konteks.teks, /Konteks proyek/);
  assert.match(konteks.teks, /proyek-uji/);
});

test("(v60-m) brief CLI: ask memakai brief proyek otomatis; --tanpa-brief meniadakannya", async () => {
  const srv = await mulaiServer((req, res, body) => {
    const parsed = JSON.parse(body);
    if (parsed.stream) balasSSE(res, [chunkTeks("baik"), chunkUsage(15)]);
    else balasChat(res, "baik", 15);
  });
  const { dir, cwd } = buatSementara();
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "vibekit.config.json"),
    JSON.stringify({
      providers: [{ nama: "tiruan", baseUrl: srv.alamat, apiKey: "kunci-uji", model: "model-tiruan" }],
      gaya: GAYA,
    })
  );
  fs.mkdirSync(path.join(cwd, ".vibekit"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".vibekit", "brief.md"), "# Brief Proyek\n\n- Penanda khas: BRIEF-KHAS-123\n");
  const env = { HOME: home };

  const denganBrief = await jalankanCli(["ask", "apa kabar?"], { cwd, env });
  assert.equal(denganBrief.kode, 0, denganBrief.stderr);
  assert.match(denganBrief.stderr, /memakai brief proyek/);
  const bodyDengan = srv.panggilan[srv.panggilan.length - 1].body;
  assert.match(bodyDengan, /BRIEF-KHAS-123/, "teks brief harus terkirim ke penyedia");

  const tanpaBrief = await jalankanCli(["ask", "--tanpa-brief", "apa kabar?"], { cwd, env });
  assert.equal(tanpaBrief.kode, 0, tanpaBrief.stderr);
  const bodyTanpa = srv.panggilan[srv.panggilan.length - 1].body;
  assert.ok(!bodyTanpa.includes("BRIEF-KHAS-123"), "--tanpa-brief harus meniadakan suntikan brief");
});
