import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { bangunKonteks, pangkasTeks } from "../dist/context.js";

test("konteks: komentar penuh dipangkas, token terseleksi lebih kecil dari mentah", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibekit-ctx-"));
  const berkas = path.join(dir, "contoh.js");
  const isi = [
    "// ini komentar panjang yang tidak berguna",
    "// komentar kedua",
    "const x = 1;",
    "",
    "",
    "",
    "",
    "console.log(x); // komentar sebaris tetap dipertahankan",
  ].join("\n");
  fs.writeFileSync(berkas, isi);

  const hasil = bangunKonteks([berkas]);
  assert.equal(hasil.jumlahFile, 1);
  assert.ok(hasil.tokenTerseleksi < hasil.tokenMentah);
  assert.match(hasil.teks, /const x = 1;/);
  assert.doesNotMatch(hasil.teks, /komentar panjang/);
});

test("konteks: file biner dilewati", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibekit-ctx-"));
  const biner = path.join(dir, "gambar.png");
  fs.writeFileSync(biner, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const hasil = bangunKonteks([biner]);
  assert.equal(hasil.jumlahFile, 0);
  assert.ok(hasil.dilewati.length >= 1);
});

test("pangkasTeks: shebang dipertahankan", () => {
  const keluar = pangkasTeks("#!/usr/bin/env node\n# komentar biasa\nconsole.log(1);");
  assert.match(keluar, /#!\/usr\/bin\/env node/);
  assert.doesNotMatch(keluar, /komentar biasa/);
});
