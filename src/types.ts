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
  /**
   * Plafon token jawaban (dikirim sebagai max_tokens). Opsional:
   * 0, null, atau tidak diisi = TANPA BATAS (field max_tokens tidak dikirim sama sekali).
   */
  maksTokenJawaban?: number;
}

export interface VibekitConfig {
  providers: ProviderConfig[];
  gaya: GayaConfig;
  /** Server MCP opsional: tool dari server-server ini menjadi tool agent tambahan. */
  mcpServers?: McpServerConfig[];
}

/**
 * Satu server MCP (Model Context Protocol). VibeKit berperan sebagai client:
 * tool yang disediakan server tampil sebagai tool agent tambahan dengan nama
 * ter-namespace `mcp__<nama>__<tool>`. Isi SALAH SATU transport:
 * `perintah` (stdio, server lokal) atau `url` (HTTP remote).
 */
export interface McpServerConfig {
  /** Nama unik server, menjadi bagian namespace tool: mcp__<nama>__<tool>. */
  nama: string;
  /** Transport stdio: perintah menjalankan server lokal, mis. "npx" atau "node". */
  perintah?: string;
  /** Argumen untuk perintah stdio. */
  argumen?: string[];
  /** Variabel lingkungan tambahan untuk proses server stdio (digabung di atas process.env). */
  env?: Record<string, string>;
  /** Transport HTTP (Streamable HTTP): URL endpoint MCP remote. */
  url?: string;
  /** Header HTTP tambahan untuk transport HTTP, mis. { "X-Goog-Api-Key": "..." }. */
  headers?: Record<string, string>;
}

/** Satu panggilan tool yang diminta model (format function calling OpenAI). */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** Argumen sebagai string JSON (format bawaan API OpenAI-compatible). */
    arguments: string;
  };
}

/** Definisi tool yang ditawarkan ke model (format function calling OpenAI). */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Boleh null/kosong pada pesan assistant yang hanya berisi tool_calls. */
  content: string | null;
  /** Hanya untuk pesan assistant: daftar panggilan tool yang diminta model. */
  tool_calls?: ToolCall[];
  /** Hanya untuk pesan tool: id ToolCall yang dijawab pesan ini. */
  tool_call_id?: string;
  /** Hanya untuk pesan tool: nama tool yang dijalankan. */
  name?: string;
}
