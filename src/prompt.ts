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
        "Jawabanmu WAJIB hanya berisi poin-poin penting dalam format poin (bullet list); tidak ada satu kata pun di luar poin.",
        "DILARANG KERAS: kalimat pembuka atau penutup dalam bentuk apa pun — termasuk sapaan, \"Berikut...\", \"Tentu!\", \"Semoga membantu\", dan sejenisnya.",
        "DILARANG: paragraf naratif, basa-basi, mengulang atau parafrase pertanyaan, menjelaskan hal yang tidak ditanyakan, dan kalimat pengisi.",
        "Satu poin = satu ide, sesingkat mungkin sambil tetap akurat dan lengkap pada intinya.",
        "Satu-satunya pengecualian: kode diberikan sebagai blok kode, tanpa penjelasan pendamping selain maksimal satu baris.",
      ].join(" ");
  }
}
