import { encode } from "gpt-tokenizer";

/** Hitung token teks (estimasi, encoding cl100k_base — cukup akurat untuk OpenAI & estimasi umum). */
export function hitungToken(teks: string): number {
  if (!teks) return 0;
  try {
    return encode(teks).length;
  } catch {
    // Cadangan kasar bila tokenizer gagal: ~4 karakter per token.
    return Math.ceil(teks.length / 4);
  }
}

export function formatAngka(n: number): string {
  return n.toLocaleString("id-ID");
}
