export interface ProviderConfig {
  /** Nama unik penyedia, mis. "gpt", "gemini", "deepseek". */
  nama: string;
  /** Basis URL OpenAI-compatible, mis. https://api.openai.com/v1 */
  baseUrl: string;
  /** API key, atau "env:NAMA_VAR" untuk mengambil dari variabel lingkungan. */
  apiKey: string;
  /** Nama model, mis. "gpt-4o-mini". */
  model: string;
  /** Batas token per hari (opsional). Penyedia dilewati bila pemakaian hari ini >= nilai ini. */
  anggaranHarian?: number;
  /** Menit cooldown untuk rate-limit singkat (bawaan 15). Kuota habis selalu cooldown sampai akhir hari lokal. */
  jedaCooldownMenit?: number;
  /** Objek tambahan yang digabung ke body permintaan (kenop khas model, mis. menekan penalaran). */
  extraBody?: Record<string, unknown>;
}

export interface GayaConfig {
  /** "poin-penting" (bawaan) | "normal" | "detail" */
  jawaban: string;
  /** Batas token jawaban (max_tokens). */
  maksTokenJawaban: number;
}

export interface VibekitConfig {
  providers: ProviderConfig[];
  gaya: GayaConfig;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
