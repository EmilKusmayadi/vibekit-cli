import type { GayaConfig } from "./types.js";

/** System prompt hemat token sesuai gaya jawaban pada konfigurasi. */
export function systemPromptHemat(gaya: GayaConfig): string {
  switch ((gaya.jawaban || "poin-penting").toLowerCase()) {
    case "detail":
      return [
        "Jawablah dengan jelas dan terstruktur.",
        "Hindari basa-basi, pembuka yang bertele-tele, dan pengulangan pertanyaan.",
        "Bila jawaban panjang diperlukan, gunakan subjudul atau poin agar mudah dipindai.",
      ].join(" ");
    case "normal":
      return [
        "Jawablah secara ringkas dan langsung ke inti.",
        "Tanpa basa-basi, tanpa mengulang pertanyaan, tanpa penjelasan yang tidak diminta.",
      ].join(" ");
    case "poin-penting":
    default:
      return [
        "Jawablah SANGAT ringkas, hanya poin-poin penting, dalam format poin (bullet list) bila cocok.",
        "DILARANG: basa-basi, pembuka/penutup sopan-santun, mengulang atau parafrase pertanyaan,",
        "menjelaskan hal yang tidak ditanyakan, dan kalimat pengisi.",
        "Satu poin = satu ide, sesingkat mungkin sambil tetap akurat dan lengkap pada intinya.",
        "Untuk kode: berikan kodenya saja ditambah penjelasan maksimal satu baris bila perlu.",
      ].join(" ");
  }
}
