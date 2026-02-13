/**
 * Pokemon TCG Pocket カード画像ダウンロードスクリプト
 *
 * tcgdex API から TCG Pocket の全カード一覧を取得し、
 * 英語・日本語の画像を images/{packId}/{cardNumber}/{locale}.jpg に保存する。
 *
 * 使い方:
 *   npx tsx scripts/download-images.ts
 *
 * オプション:
 *   --dry-run          ダウンロードせずに対象カード一覧を表示
 *   --set A1           特定セットのみダウンロード
 *   --locale en        特定言語のみダウンロード（デフォルト: en）
 *   --quality high     画像品質: low | high（デフォルト: high）
 *   --force            既存ファイルも再ダウンロード
 *   --concurrency 5    同時ダウンロード数（デフォルト: 5）
 */

import fs from "fs";
import path from "path";

// ── 設定 ──────────────────────────────────────────────

const API_BASE = "https://api.tcgdex.net/v2/en";
const ASSETS_BASE = "https://assets.tcgdex.net";
const SERIES_ID = "tcgp";
const OUTPUT_DIR = path.resolve(process.cwd(), "images");
const LOCALES = ["en", "ja"] as const;
const DEFAULT_CONCURRENCY = 5;
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 1000;
const REQUEST_DELAY_MS = 100;

type Locale = (typeof LOCALES)[number];
type Quality = "low" | "high";

// ── 型定義 ──────────────────────────────────────────────

interface SetBrief {
  id: string;
  name: string;
  cardCount?: { total: number; official: number };
}

interface SeriesResponse {
  id: string;
  name: string;
  sets: SetBrief[];
}

interface CardBrief {
  id: string;
  localId: string;
  name: string;
  image: string; // e.g. "https://assets.tcgdex.net/en/tcgp/A1/001"
}

interface SetResponse {
  id: string;
  name: string;
  cards: CardBrief[];
}

interface DownloadTask {
  url: string;
  dest: string;
  label: string;
}

// ── 引数パース ──────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);

  function getArgValue(flag: string): string | null {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
  }

  const localeArg = getArgValue("--locale");
  let locales: Locale[];
  if (localeArg) {
    if (!LOCALES.includes(localeArg as Locale)) {
      console.error(
        `❌ 無効なlocale: "${localeArg}"。使用可能: ${LOCALES.join(", ")}`
      );
      process.exit(1);
    }
    locales = [localeArg as Locale];
  } else {
    locales = ["en"];
  }

  const qualityArg = getArgValue("--quality");
  let quality: Quality = "high";
  if (qualityArg) {
    if (qualityArg !== "low" && qualityArg !== "high") {
      console.error(`❌ 無効なquality: "${qualityArg}"。使用可能: low, high`);
      process.exit(1);
    }
    quality = qualityArg;
  }

  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    set: getArgValue("--set"),
    locales,
    quality,
    concurrency: parseInt(getArgValue("--concurrency") ?? "", 10) || DEFAULT_CONCURRENCY,
  };
}

const flags = parseArgs();

// ── ユーティリティ ────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${url}`);
  }
  return res.json() as Promise<T>;
}

/**
 * tcgdex の画像URLを組み立てる
 * 例: https://assets.tcgdex.net/ja/tcgp/A1/001/low.jpg
 */
function buildImageUrl(
  locale: Locale,
  setId: string,
  localId: string,
  quality: Quality
): string {
  return `${ASSETS_BASE}/${locale}/tcgp/${setId}/${localId}/${quality}.jpg`;
}

async function downloadFile(
  url: string,
  dest: string
): Promise<{ success: boolean; skipped: boolean }> {
  if (!flags.force && fs.existsSync(dest)) {
    return { success: true, skipped: true };
  }

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      const res = await fetch(url);

      if (res.status === 404) {
        // 日本語版が存在しないカードもありうる
        return { success: false, skipped: false };
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buffer);

      return { success: true, skipped: false };
    } catch (err) {
      if (attempt < RETRY_COUNT) {
        console.warn(
          `  ⚠ リトライ ${attempt}/${RETRY_COUNT}: ${url} - ${(err as Error).message}`
        );
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        console.error(`  ✗ 失敗: ${url} - ${(err as Error).message}`);
        return { success: false, skipped: false };
      }
    }
  }

  return { success: false, skipped: false };
}

// ── 並行ダウンロード ──────────────────────────────────────

async function downloadWithConcurrency(
  tasks: DownloadTask[],
  concurrency: number
) {
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let index = 0;
  const total = tasks.length;
  const failedList: string[] = [];

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      const task = tasks[i];

      const result = await downloadFile(task.url, task.dest);

      if (result.skipped) {
        skipped++;
      } else if (result.success) {
        downloaded++;
      } else {
        failed++;
        failedList.push(task.label);
      }

      const done = downloaded + skipped + failed;
      process.stdout.write(
        `\r  📥 ${done}/${total} (新規: ${downloaded}, スキップ: ${skipped}, 失敗: ${failed})`
      );

      // 新規ダウンロード時のみディレイ
      if (!result.skipped) {
        await sleep(REQUEST_DELAY_MS);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  console.log("");
  return { downloaded, skipped, failed, failedList };
}

// ── メイン処理 ──────────────────────────────────────────

async function main() {
  console.log("🔍 TCG Pocket カード画像ダウンローダー");
  console.log(`   出力先: ${OUTPUT_DIR}`);
  console.log(`   言語: ${flags.locales.join(", ")}`);
  console.log(`   品質: ${flags.quality}`);
  console.log(`   同時接続数: ${flags.concurrency}`);
  if (flags.dryRun) console.log("   🏷  ドライラン（ダウンロードしません）");
  if (flags.force) console.log("   🔄 強制再ダウンロード");
  if (flags.set) console.log(`   📦 対象セット: ${flags.set}`);
  console.log("");

  // Step 1: シリーズからセット一覧を取得
  console.log(`📡 シリーズ「${SERIES_ID}」のセット一覧を取得中...`);
  const series = await fetchJson<SeriesResponse>(
    `${API_BASE}/series/${SERIES_ID}`
  );

  let sets = series.sets;
  if (flags.set) {
    sets = sets.filter((s) => s.id === flags.set);
    if (sets.length === 0) {
      const available = series.sets.map((s) => s.id).join(", ");
      console.error(
        `❌ セット「${flags.set}」が見つかりません。利用可能: ${available}`
      );
      process.exit(1);
    }
  }

  console.log(
    `   ${sets.length} セット: ${sets.map((s) => `${s.name} (${s.id})`).join(", ")}`
  );
  console.log("");

  // Step 2: 各セットのカード一覧を取得 → ダウンロードタスク構築
  const tasks: DownloadTask[] = [];

  for (const set of sets) {
    console.log(`📦 ${set.name} (${set.id}) のカード一覧を取得中...`);
    await sleep(REQUEST_DELAY_MS);

    const setData = await fetchJson<SetResponse>(
      `${API_BASE}/sets/${set.id}`
    );

    console.log(`   ${setData.cards.length} 枚`);

    for (const card of setData.cards) {
      for (const locale of flags.locales) {
        const url = buildImageUrl(locale, set.id, card.localId, flags.quality);
        const dest = path.join(
          OUTPUT_DIR,
          set.id,
          card.localId,
          `${locale}.jpg`
        );

        tasks.push({
          url,
          dest,
          label: `${set.id}/${card.localId}/${locale}.jpg (${card.name})`,
        });
      }
    }
  }

  console.log("");
  console.log(
    `📊 合計: ${tasks.length} ファイル（${tasks.length / flags.locales.length} 枚 × ${flags.locales.length} 言語）`
  );

  // ドライラン
  if (flags.dryRun) {
    console.log("");
    console.log("── カード一覧 ──");
    for (const task of tasks) {
      const exists = fs.existsSync(task.dest) ? "✓" : "·";
      console.log(`  ${exists} ${task.label}`);
    }

    const existing = tasks.filter((t) => fs.existsSync(t.dest)).length;
    console.log("");
    console.log(`   既存: ${existing}, 新規: ${tasks.length - existing}`);
    return;
  }

  // Step 3: ダウンロード実行
  console.log("");
  console.log("📥 ダウンロード開始...");

  const result = await downloadWithConcurrency(tasks, flags.concurrency);

  // サイズ集計
  let totalSize = 0;
  for (const task of tasks) {
    if (fs.existsSync(task.dest)) {
      totalSize += fs.statSync(task.dest).size;
    }
  }

  console.log("");
  console.log("── 完了 ──");
  console.log(`  ✅ 新規ダウンロード: ${result.downloaded}`);
  console.log(`  ⏭  スキップ（既存）: ${result.skipped}`);
  if (result.failed > 0) {
    console.log(`  ❌ 失敗: ${result.failed}`);
    console.log("  失敗一覧:");
    for (const label of result.failedList) {
      console.log(`    - ${label}`);
    }
  }
  console.log(`  💾 合計サイズ: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((err) => {
  console.error("❌ エラー:", err);
  process.exit(1);
});
