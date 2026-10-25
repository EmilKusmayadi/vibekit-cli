import { selesaikanApiKey } from "./config.js";
import { systemPromptHemat } from "./prompt.js";
import {
  akhirHariIni,
  catatPemakaianHarian,
  formatJam,
  muatState,
  sedangCooldown,
  simpanState,
  statePenyedia,
} from "./state.js";
import { formatAngka, hitungToken } from "./token.js";
import type { ChatMessage, ProviderConfig, ToolCall, ToolDefinition, VibekitConfig } from "./types.js";

export interface CatatanPenyedia {
  nama: string;
  model: string;
  status: string;
  alasan: string;
  tersediaLagi?: string;
}

export type HasilTanya =
  | {
      ok: true;
      jawaban: string;
      /** Panggilan tool yang diminta model (bila respons berisi tool_calls). */
      toolCalls?: ToolCall[];
      /** Pesan assistant mentah dari penyedia, untuk diteruskan apa adanya ke riwayat percakapan (Gemini 3 menyisipkan thought_signature di dalam tool_calls dan menolak riwayat tanpanya dengan HTTP 400). */
      pesanMentah?: unknown;
      provider: ProviderConfig;
      tokenTerpakai: number;
      tokenSumber: "usage" | "estimasi";
      catatan: CatatanPenyedia[];
    }
  | {
      ok: false;
      pesan: string;
      catatan: CatatanPenyedia[];
      /**
       * true bila kegagalan terjadi di TENGAH aliran streaming setelah ada
       * token yang keluar: permintaan TIDAK di-failover (menghindari keluaran
       * ganda), dan sebagian jawaban mungkin sudah tercetak ke pengguna.
       */
      streamTerputus?: boolean;
    };

type JenisError = "kuota" | "rate-limit" | "lainnya";

const POLA_KUOTA =
  /insufficient_quota|resource_exhausted|quota exceeded|exceeded your quota|kuota|insufficient balance|balance is too low|credit balance|billing/i;

/** Klasifikasikan kegagalan HTTP: kuota habis, rate-limit singkat, atau error lain. */
export function klasifikasiError(status: number, bodyTeks: string): { jenis: JenisError; ringkas: string } {
  const potongan = bodyTeks.replace(/\s+/g, " ").slice(0, 200);
  if (status === 402 || POLA_KUOTA.test(bodyTeks)) {
    return { jenis: "kuota", ringkas: `kuota/saldo habis (HTTP ${status}) ${potongan}`.trim() };
  }
  if (status === 429) {
    return { jenis: "rate-limit", ringkas: `terkena rate-limit (HTTP 429) ${potongan}`.trim() };
  }
  if (status === 503) {
    return { jenis: "lainnya", ringkas: `server penyedia sedang sibuk/penuh (HTTP 503) ${potongan}`.trim() };
  }
  return { jenis: "lainnya", ringkas: `HTTP ${status} ${potongan}`.trim() };
}

type HasilAliran =
  | { jenis: "sukses"; data: { choices: unknown[]; usage?: unknown } }
  | { jenis: "pra-token"; alasan: string }
  | { jenis: "tengah"; alasan: string };

/**
 * Baca aliran SSE (mode streaming) dari respons penyedia dan rakit menjadi
 * objek `data` yang SETARA BENTUKNYA dengan respons non-streaming:
 * `choices[0].message` berisi content terakumulasi dan tool_calls yang sudah
 * digabung per `index` — termasuk `extra_content` (thought_signature Gemini)
 * bila muncul pada delta tool_call, agar riwayat & kompaksi tetap bekerja.
 *
 * Hasil dibedakan menurut kapan kegagalan terjadi:
 * - "pra-token": aliran gagal sebelum ada keluaran apa pun → pemanggil boleh
 *   memperlakukannya sebagai kegagalan penyedia biasa (failover).
 * - "tengah": aliran putus SETELAH ada token keluar → pemanggil TIDAK BOLEH
 *   failover karena akan menggandakan keluaran ke pengguna.
 */
async function bacaAliranSSE(
  respons: Response,
  provider: ProviderConfig,
  opsi: OpsiTanya,
  timeoutMs: number
): Promise<HasilAliran> {
  const body = respons.body;
  if (!body) return { jenis: "pra-token", alasan: "respons streaming tidak memiliki body" };
  const pembaca = body.getReader();
  const dekoder = new TextDecoder();
  let buffer = "";
  let konten = "";
  const perIndeks = new Map<number, { id: string; nama: string; argumen: string; extraContent?: unknown }>();
  let usage: unknown;
  let adaKeluaran = false;
  let tokenPertamaDilaporkan = false;

  const prosesBaris = (baris: string): void => {
    const rapi = baris.trim();
    if (!rapi.startsWith("data:")) return;
    const muatan = rapi.slice("data:".length).trim();
    if (!muatan || muatan === "[DONE]") return;
    let potong: any;
    try {
      potong = JSON.parse(muatan);
    } catch {
      return; // baris data rusak/komentar: lewati, jangan gagalkan aliran
    }
    if (potong?.usage) usage = potong.usage;
    const delta = Array.isArray(potong?.choices) ? potong.choices[0]?.delta : undefined;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content !== "") {
      konten += delta.content;
      adaKeluaran = true;
      if (!tokenPertamaDilaporkan) {
        tokenPertamaDilaporkan = true;
        opsi.onTokenPertama?.(provider);
      }
      opsi.onToken?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const dtc of delta.tool_calls) {
        const indeks = typeof dtc?.index === "number" ? dtc.index : 0;
        let entri = perIndeks.get(indeks);
        if (!entri) {
          entri = { id: "", nama: "", argumen: "" };
          perIndeks.set(indeks, entri);
        }
        if (typeof dtc.id === "string" && dtc.id) entri.id = dtc.id;
        if (typeof dtc.function?.name === "string") entri.nama += dtc.function.name;
        if (typeof dtc.function?.arguments === "string") entri.argumen += dtc.function.arguments;
        if (dtc.extra_content !== undefined) entri.extraContent = dtc.extra_content;
        adaKeluaran = true;
      }
    }
  };

  let waktuHabis = false;
  const pengatur = setTimeout(() => {
    waktuHabis = true;
    pembaca.cancel().catch(() => {});
  }, timeoutMs);
  try {
    for (;;) {
      const { done, value } = await pembaca.read();
      if (done) break;
      buffer += dekoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        prosesBaris(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) prosesBaris(buffer);
  } catch (e) {
    const alasan = `aliran streaming terputus: ${(e as Error).message}`;
    return adaKeluaran ? { jenis: "tengah", alasan } : { jenis: "pra-token", alasan };
  } finally {
    clearTimeout(pengatur);
  }
  if (waktuHabis) {
    const alasan = `aliran streaming melewati batas waktu ${timeoutMs} ms`;
    return adaKeluaran ? { jenis: "tengah", alasan } : { jenis: "pra-token", alasan };
  }

  const toolCalls = [...perIndeks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, e]) => ({
      ...(e.id ? { id: e.id } : {}),
      type: "function",
      function: { name: e.nama, arguments: e.argumen },
      ...(e.extraContent !== undefined ? { extra_content: e.extraContent } : {}),
    }));
  const pesan: Record<string, unknown> = {
    role: "assistant",
    content: konten === "" ? null : konten,
  };
  if (toolCalls.length > 0) pesan.tool_calls = toolCalls;
  return {
    jenis: "sukses",
    data: { choices: [{ message: pesan }], ...(usage !== undefined ? { usage } : {}) },
  };
}

interface OpsiTanya {
  config: VibekitConfig;
  /** Pesan percakapan TANPA system prompt (router menambahkannya dari gaya). */
  messages: ChatMessage[];
  lokasiState: string;
  fetchImpl?: typeof fetch;
  sekarang?: Date;
  timeoutMs?: number;
  /** Jeda antar percobaan ulang khusus HTTP 503 (server sibuk sesaat). Bawaan [3000, 8000] ms. */
  jedaRetry503Ms?: number[];
  tungguImpl?: (ms: number) => Promise<void>;
  /** Definisi tool (function calling) yang ditawarkan ke model; diteruskan apa adanya ke body permintaan. */
  tools?: ToolDefinition[];
  /**
   * Mode streaming: jawaban teks dialirkan potongan demi potongan lewat
   * `onToken` begitu tiba (SSE). Error HTTP sebelum token pertama diperlakukan
   * seperti jalur biasa (retry 503 / cooldown / failover); error SETELAH ada
   * token keluar tidak di-failover — lihat `streamTerputus` pada hasil gagal.
   */
  stream?: boolean;
  /** Dipanggil untuk setiap potongan teks jawaban (delta.content) saat streaming. */
  onToken?: (potongan: string) => void;
  /** Dipanggil SEKALI saat token pertama tiba, dengan penyedia yang memenangkannya. */
  onTokenPertama?: (provider: ProviderConfig) => void;
}

/**
 * Mesin router: coba penyedia sesuai urutan prioritas konfigurasi.
 * - Penyedia yang cooldown / anggaran hariannya tercapai dilewati tanpa dipanggil.
 * - Kuota habis (429/402/pola kuota) → cooldown sampai akhir hari lokal, lalu permintaan
 *   yang sama diulangi ke penyedia berikutnya secara transparan.
 * - Rate-limit singkat → cooldown jedaCooldownMenit (bawaan 15).
 * - HTTP 503 (server penyedia sibuk sesaat) → penyedia yang sama dicoba ulang sampai
 *   2 kali dengan jeda (3 dtk, 8 dtk) sebelum menyerah ke penyedia berikutnya;
 *   503 tidak memicu cooldown.
 * - Error lain (401, 400, jaringan) tidak dianggap kuota habis; dicatat dan lanjut ke berikutnya.
 * - Mode streaming (opsi.stream): aturan di atas berlaku untuk error yang
 *   terjadi SEBELUM token pertama (status HTTP / aliran kosong). Error di
 *   tengah aliran setelah token keluar TIDAK di-failover; hasilnya gagal
 *   dengan `streamTerputus: true`.
 */
export async function tanyaRouter(opsi: OpsiTanya): Promise<HasilTanya> {
  const fetchImpl = opsi.fetchImpl ?? fetch;
  const sekarang = opsi.sekarang ?? new Date();
  const timeoutMs = opsi.timeoutMs ?? 90_000;
  const jedaRetry503 = opsi.jedaRetry503Ms ?? [3000, 8000];
  const tunggu = opsi.tungguImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const state = muatState(opsi.lokasiState);
  const catatan: CatatanPenyedia[] = [];

  const system: ChatMessage = { role: "system", content: systemPromptHemat(opsi.config.gaya) };
  const semuaPesan = [system, ...opsi.messages];
  const tokenPromptEstimasi = hitungToken(semuaPesan.map((m) => m.content ?? "").join("\n"));

  for (const provider of opsi.config.providers) {
    const entri = statePenyedia(state, provider.nama, sekarang);

    if (sedangCooldown(entri, sekarang)) {
      catatan.push({
        nama: provider.nama,
        model: provider.model,
        status: "cooldown",
        alasan: entri.alasanTerakhir ?? "sedang istirahat (cooldown)",
        tersediaLagi: entri.cooldownUntil ? formatJam(entri.cooldownUntil) : undefined,
      });
      continue;
    }

    if (typeof provider.anggaranHarian === "number" && entri.totalToken >= provider.anggaranHarian) {
      catatan.push({
        nama: provider.nama,
        model: provider.model,
        status: "anggaran-tercapai",
        alasan: `anggaran harian tercapai (${formatAngka(entri.totalToken)} / ${formatAngka(provider.anggaranHarian)} token)`,
        tersediaLagi: "besok (reset harian)",
      });
      continue;
    }

    const apiKey = selesaikanApiKey(provider.apiKey ?? "");
    if (!apiKey) {
      catatan.push({
        nama: provider.nama,
        model: provider.model,
        status: "tanpa-kunci",
        alasan: "API key belum diisi di konfigurasi",
      });
      continue;
    }
    if (!provider.baseUrl) {
      catatan.push({
        nama: provider.nama,
        model: provider.model,
        status: "konfigurasi-salah",
        alasan: "baseUrl kosong dan tidak ada bawaan untuk nama penyedia ini",
      });
      continue;
    }

    const url = provider.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    // max_tokens hanya dikirim bila plafon diatur > 0. Nilai 0/kosong/tidak diisi
    // = tanpa batas: field tidak dikirim sama sekali, batas bawaan model berlaku.
    const maksToken = opsi.config.gaya.maksTokenJawaban;
    const body: Record<string, unknown> = {
      model: provider.model,
      messages: semuaPesan,
      ...(typeof maksToken === "number" && maksToken > 0 ? { max_tokens: maksToken } : {}),
      ...(opsi.tools && opsi.tools.length > 0 ? { tools: opsi.tools } : {}),
      ...(provider.extraBody ?? {}),
    };
    if (opsi.stream) {
      // include_usage agar token terpakai tetap dilaporkan penyedia di akhir
      // aliran; penyedia yang tidak mengirim usage diestimasi secara lokal.
      body.stream = true;
      body.stream_options = { include_usage: true };
    }

    let respons: Response | undefined;
    let teks = "";
    let gagalJaringan: string | null = null;
    let percobaan503 = 0;
    for (;;) {
      try {
        const kontroler = new AbortController();
        const pengatur = setTimeout(() => kontroler.abort(), timeoutMs);
        try {
          respons = await fetchImpl(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: kontroler.signal,
          });
        } finally {
          clearTimeout(pengatur);
        }
      } catch (e) {
        gagalJaringan = `gagal jaringan: ${(e as Error).message}`;
        break;
      }
      // 503 = server penyedia sedang penuh sesaat: coba ulang penyedia yang sama
      // dengan jeda sebelum menyerah ke penyedia berikutnya. Keputusan dibuat
      // dari STATUS (header) sebelum body dibaca, supaya body — terutama aliran
      // streaming — tidak terkonsumsi oleh percobaan yang akan diulang.
      if (respons.status === 503 && percobaan503 < jedaRetry503.length) {
        try {
          await respons.body?.cancel();
        } catch {
          /* abaikan: body percobaan gagal memang dibuang */
        }
        await tunggu(jedaRetry503[percobaan503]);
        percobaan503++;
        continue;
      }
      break;
    }

    if (gagalJaringan !== null || !respons) {
      const alasan = gagalJaringan ?? "gagal jaringan";
      entri.alasanTerakhir = alasan;
      simpanState(opsi.lokasiState, state);
      catatan.push({ nama: provider.nama, model: provider.model, status: "gagal", alasan });
      continue;
    }

    if (!respons.ok) {
      teks = await respons.text();
      const { jenis, ringkas } = klasifikasiError(respons.status, teks);
      entri.alasanTerakhir = ringkas;
      if (jenis === "kuota") {
        entri.cooldownUntil = akhirHariIni(sekarang).toISOString();
      } else if (jenis === "rate-limit") {
        const menit = provider.jedaCooldownMenit ?? 15;
        entri.cooldownUntil = new Date(sekarang.getTime() + menit * 60_000).toISOString();
      }
      simpanState(opsi.lokasiState, state);
      catatan.push({
        nama: provider.nama,
        model: provider.model,
        status: jenis === "lainnya" ? "gagal" : "cooldown",
        alasan: ringkas,
        tersediaLagi: entri.cooldownUntil ? formatJam(entri.cooldownUntil) : undefined,
      });
      continue;
    }

    let data: any;
    if (opsi.stream && respons.body) {
      const aliran = await bacaAliranSSE(respons, provider, opsi, timeoutMs);
      if (aliran.jenis === "pra-token") {
        // Belum ada token yang keluar: kegagalan penyedia biasa, failover lanjut.
        entri.alasanTerakhir = aliran.alasan;
        simpanState(opsi.lokasiState, state);
        catatan.push({ nama: provider.nama, model: provider.model, status: "gagal", alasan: aliran.alasan });
        continue;
      }
      if (aliran.jenis === "tengah") {
        // Token sudah keluar ke pengguna: JANGAN failover (keluaran akan
        // ganda). Laporkan sebagai kegagalan giliran khusus.
        entri.alasanTerakhir = aliran.alasan;
        simpanState(opsi.lokasiState, state);
        catatan.push({ nama: provider.nama, model: provider.model, status: "gagal", alasan: aliran.alasan });
        return {
          ok: false,
          pesan:
            `Aliran jawaban dari ${provider.nama} (${provider.model}) terputus di tengah jalan — ${aliran.alasan}. ` +
            "Sebagian jawaban mungkin sudah tampil; permintaan TIDAK diulang ke penyedia lain agar keluaran tidak ganda.",
          catatan,
          streamTerputus: true,
        };
      }
      data = aliran.data;
    } else {
      teks = await respons.text();
      try {
        data = JSON.parse(teks);
      } catch {
        const alasan = "respons bukan JSON yang valid";
        entri.alasanTerakhir = alasan;
        simpanState(opsi.lokasiState, state);
        catatan.push({ nama: provider.nama, model: provider.model, status: "gagal", alasan });
        continue;
      }
    }

    const pesanMentah = data?.choices?.[0]?.message;
    const jawaban: string = pesanMentah?.content ?? "";
    const toolCallsMentah: unknown = pesanMentah?.tool_calls;
    const toolCalls: ToolCall[] = Array.isArray(toolCallsMentah)
      ? toolCallsMentah
          .filter(
            (t): t is ToolCall =>
              !!t && typeof t === "object" && typeof (t as ToolCall).function?.name === "string"
          )
          .map((t, i) => ({
            id: typeof t.id === "string" && t.id ? t.id : `panggilan-${i + 1}`,
            type: "function" as const,
            function: {
              name: t.function.name,
              arguments: typeof t.function.arguments === "string" ? t.function.arguments : JSON.stringify(t.function.arguments ?? {}),
            },
          }))
      : [];
    // Respons berisi tool_calls sah walau content kosong (mode agent).
    if (!jawaban && toolCalls.length === 0) {
      const alasan = "respons tidak berisi jawaban (choices kosong)";
      entri.alasanTerakhir = alasan;
      simpanState(opsi.lokasiState, state);
      catatan.push({ nama: provider.nama, model: provider.model, status: "gagal", alasan });
      continue;
    }

    let tokenTerpakai: number;
    let tokenSumber: "usage" | "estimasi";
    const usage = data?.usage;
    if (usage && typeof usage.total_tokens === "number") {
      tokenTerpakai = usage.total_tokens;
      tokenSumber = "usage";
    } else if (usage && typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number") {
      tokenTerpakai = usage.prompt_tokens + usage.completion_tokens;
      tokenSumber = "usage";
    } else {
      // Estimasi juga menghitung argumen tool_calls (bagian dari keluaran model).
      const teksTool = toolCalls.map((t) => `${t.function.name} ${t.function.arguments}`).join("\n");
      tokenTerpakai = tokenPromptEstimasi + hitungToken(jawaban) + (teksTool ? hitungToken(teksTool) : 0);
      tokenSumber = "estimasi";
    }

    entri.totalToken += tokenTerpakai;
    catatPemakaianHarian(state, provider.nama, tokenTerpakai, sekarang);
    entri.alasanTerakhir = null;
    simpanState(opsi.lokasiState, state);

    return {
      ok: true,
      jawaban,
      ...(toolCalls.length > 0 ? { toolCalls, pesanMentah } : {}),
      provider,
      tokenTerpakai,
      tokenSumber,
      catatan,
    };
  }

  const baris = catatan.map((c) => {
    const lagi = c.tersediaLagi ? ` — bisa dicoba lagi ${c.tersediaLagi}` : "";
    return `  • ${c.nama} (${c.model}): ${c.status} — ${c.alasan}${lagi}`;
  });
  const palingAwal = catatan
    .filter((c) => c.tersediaLagi && c.status === "cooldown")
    .map((c) => c.tersediaLagi as string)
    .sort()[0];
  const pesan =
    "Semua penyedia gagal atau sedang tidak tersedia:\n" +
    baris.join("\n") +
    (palingAwal ? `\nPenyedia paling awal bisa dicoba lagi sekitar pukul ${palingAwal}.` : "");
  return { ok: false, pesan, catatan };
}
