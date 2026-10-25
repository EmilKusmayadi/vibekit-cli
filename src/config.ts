import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderConfig, VibekitConfig } from "./types.js";

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
  const config: VibekitConfig = {
    providers: obj.providers.map((p) => normalisasiProvider(p as ProviderConfig)),
    gaya: {
      jawaban: obj.gaya?.jawaban ?? "poin-penting",
      maksTokenJawaban: typeof obj.gaya?.maksTokenJawaban === "number" ? obj.gaya.maksTokenJawaban : 800,
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
