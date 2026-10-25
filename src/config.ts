import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerConfig, ProviderConfig, VibekitConfig } from "./types.js";

export function configDir(): string {
  return path.join(os.homedir(), ".vibekit");
}

export function globalConfigPath(): string {
  return path.join(configDir(), "config.json");
}

export function statePath(): string {
  return path.join(configDir(), "state.json");
}

export function projectConfigPath(cwd: string = process.cwd()): string {
  return path.join(cwd, "vibekit.config.json");
}

const BASE_URL_BAWAAN: Record<string, string> = {
  gpt: "https://api.openai.com/v1",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  google: "https://generativelanguage.googleapis.com/v1beta/openai/",
  deepseek: "https://api.deepseek.com/v1",
};

export const TEMPLATE_CONFIG: VibekitConfig = {
  providers: [
    {
      nama: "gpt",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o-mini",
      anggaranHarian: 500000,
      jedaCooldownMenit: 15,
    },
    {
      nama: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      apiKey: "",
      model: "gemini-3.8-flash",
      jedaCooldownMenit: 15,
    },
    {
      nama: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "",
      model: "deepseek-chat",
      jedaCooldownMenit: 15,
    },
  ],
  gaya: { jawaban: "poin-penting", maksTokenJawaban: 800 },
};

/** Buat ~/.vibekit/config.json dari template. Kembalikan false bila sudah ada (tidak ditimpa). */
export function buatConfigGlobal(): boolean {
  const target = globalConfigPath();
  if (fs.existsSync(target)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(TEMPLATE_CONFIG, null, 2) + "\n", "utf8");
  return true;
}

function normalisasiProvider(p: Partial<ProviderConfig> & { nama: string }): ProviderConfig {
  const nama = String(p.nama);
  return {
    nama,
    baseUrl: p.baseUrl ?? BASE_URL_BAWAAN[nama.toLowerCase()] ?? "",
    apiKey: p.apiKey ?? "",
    model: p.model ?? "",
    anggaranHarian: typeof p.anggaranHarian === "number" ? p.anggaranHarian : undefined,
    jedaCooldownMenit: typeof p.jedaCooldownMenit === "number" ? p.jedaCooldownMenit : undefined,
    extraBody: p.extraBody,
  };
}

/** Saring rekaman bebas menjadi Record<string,string> (hanya nilai string yang dipertahankan). */
function rekamanString(mentah: unknown): Record<string, string> {
  const hasil: Record<string, string> = {};
  if (mentah && typeof mentah === "object") {
    for (const [k, v] of Object.entries(mentah as Record<string, unknown>)) {
      if (typeof v === "string") hasil[k] = v;
    }
  }
  return hasil;
}

/**
 * Normalisasi daftar mcpServers dari konfigurasi mentah (validasi ringan):
 * entri wajib punya "nama" dan salah satu dari "perintah" (stdio) / "url"
 * (HTTP); entri yang tidak memenuhi syarat dilewati, bukan menggagalkan muat.
 */
function normalisasiMcpServers(mentah: unknown): McpServerConfig[] | undefined {
  if (!Array.isArray(mentah)) return undefined;
  const hasil: McpServerConfig[] = [];
  for (const entri of mentah) {
    if (!entri || typeof entri !== "object") continue;
    const o = entri as Record<string, unknown>;
    const nama = typeof o.nama === "string" ? o.nama.trim() : "";
    const perintah = typeof o.perintah === "string" && o.perintah.trim() !== "" ? o.perintah : undefined;
    const url = typeof o.url === "string" && o.url.trim() !== "" ? o.url : undefined;
    if (!nama || (!perintah && !url)) continue;
    hasil.push({
      nama,
      ...(perintah ? { perintah } : {}),
      ...(Array.isArray(o.argumen)
        ? { argumen: o.argumen.filter((a): a is string => typeof a === "string") }
        : {}),
      ...(o.env && typeof o.env === "object" ? { env: rekamanString(o.env) } : {}),
      ...(url ? { url } : {}),
      ...(o.headers && typeof o.headers === "object" ? { headers: rekamanString(o.headers) } : {}),
    });
  }
  return hasil.length > 0 ? hasil : undefined;
}

/**
 * Muat konfigurasi: file proyek ./vibekit.config.json menimpa global ~/.vibekit/config.json.
 * Lempar Error dengan pesan Bahasa Indonesia bila tidak ada konfigurasi / tidak valid.
 */
export function muatConfig(cwd: string = process.cwd()): { config: VibekitConfig; sumber: string } {
  const proyek = projectConfigPath(cwd);
  const global = globalConfigPath();
  const sumber = fs.existsSync(proyek) ? proyek : fs.existsSync(global) ? global : null;
  if (!sumber) {
    throw new Error(
      "Konfigurasi tidak ditemukan. Jalankan `vibekit init` untuk membuat ~/.vibekit/config.json, " +
        "atau buat file vibekit.config.json di folder proyek ini."
    );
  }
  let mentah: unknown;
  try {
    mentah = JSON.parse(fs.readFileSync(sumber, "utf8"));
  } catch (e) {
    throw new Error(`Konfigurasi di ${sumber} bukan JSON yang valid: ${(e as Error).message}`);
  }
  const obj = mentah as Partial<VibekitConfig>;
  if (!obj || !Array.isArray(obj.providers) || obj.providers.length === 0) {
    throw new Error(`Konfigurasi di ${sumber} harus berisi array "providers" yang tidak kosong.`);
  }
  const mcpServers = normalisasiMcpServers((obj as { mcpServers?: unknown }).mcpServers);
  const config: VibekitConfig = {
    providers: obj.providers.map((p) => normalisasiProvider(p as ProviderConfig)),
    ...(mcpServers ? { mcpServers } : {}),
    gaya: {
      jawaban: obj.gaya?.jawaban ?? "poin-penting",
      // Angka dipertahankan apa adanya (termasuk 0 = tanpa batas); tidak diisi/null
      // dibiarkan undefined agar router tidak mengirim max_tokens sama sekali.
      maksTokenJawaban: typeof obj.gaya?.maksTokenJawaban === "number" ? obj.gaya.maksTokenJawaban : undefined,
    },
  };
  return { config, sumber };
}

/** Selesaikan nilai apiKey: sintaks "env:NAMA_VAR" dibaca dari variabel lingkungan. */
export function selesaikanApiKey(apiKey: string): string {
  if (apiKey.startsWith("env:")) {
    const namaVar = apiKey.slice(4).trim();
    return process.env[namaVar] ?? "";
  }
  return apiKey;
}
