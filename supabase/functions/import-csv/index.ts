// Supabase Edge Function: import-csv
// Google Drive の「カード明細インポート/<カード名>/」フォルダにあるCSVを取り込み、
// card_statements に source='auto', status='confirmed' として登録する。
// （以前は 'needs_review' をデフォルトにしていたが、取り込み結果は
// 基本的に正しいため最初から確定済みとして扱い、必要なら list.html の
// 「編集」から後で直せるようにする。マイナス金額や日付形式が想定外の行は
// parseCsv() の時点で card_statements に登録されずスキップされ、
// import_logs の error_message に要確認として記録される。）
// 呼び出し方法は2通り:
//   1. Supabase Cron（pg_cron + pg_net）から毎日1回、ヘッダー x-cron-secret 付きで呼ぶ
//   2. アプリ画面（自動取得ログ）の「今すぐ実行」ボタンから、ログイン中ユーザーのJWT付きで呼ぶ
//
// デプロイ: supabase functions deploy import-csv --no-verify-jwt
// （JWT検証はこの関数の中で独自に行うため、Supabase標準の自動検証は無効にする）
//
// カテゴリ自動分類: merchant_categories（利用先キーワード→カテゴリ、priority、source）に
// 一致すればそれを使う。一致しない「初めての利用先」は、
// CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN が設定されていれば
// Cloudflare Workers AI に推測してもらい、結果をその場でmerchant_categoriesに
// source='ai'として記録する（次回以降はAI判定なしで自動分類される）。AIが「不明」と
// 判断した場合やシークレット未設定の場合はcategoryをnullのままにし、list.html側で
// 人間の判断に回す。
//
// card_statements.category_source には、そのカテゴリが人間確定のキーワードに
// 一致したのか('human')、AI推測のキーワードに一致した/今回AIが推測したのか('ai')を
// 記録する。list.html はこれを見て、AI推測のものを「要確認」として表示する
// （AIはCloudflare Workers AIの無料枠の小型モデルのため、精度が完璧ではないため）。

import { createClient } from "npm:@supabase/supabase-js@2";

// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY は
// Supabaseが全Edge Functionに自動的に渡す予約済みの環境変数（自分でsecrets setする必要はない）
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SECRET_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_PUBLISHABLE_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CRON_SHARED_SECRET = Deno.env.get("CRON_SHARED_SECRET")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const GOOGLE_REFRESH_TOKEN = Deno.env.get("GOOGLE_REFRESH_TOKEN")!;
const DRIVE_ROOT_FOLDER_ID = Deno.env.get("DRIVE_ROOT_FOLDER_ID")!; // 「カード明細インポート」フォルダのID

// Cloudflare Workers AI（カテゴリ自動分類のAI判定、任意機能）
// 未設定の場合はAI判定を使わず、ルールに一致しない利用先はそのまま
// カテゴリ未設定（人間の判断待ち）になる。設定は必須ではない。
const CLOUDFLARE_ACCOUNT_ID = Deno.env.get("CLOUDFLARE_ACCOUNT_ID") ?? "";
const CLOUDFLARE_API_TOKEN = Deno.env.get("CLOUDFLARE_API_TOKEN") ?? "";
const CLOUDFLARE_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

// ---------------------------------------------------------------------------
// CORS: GitHub Pages（ブラウザの「今すぐ実行」ボタン）から直接fetchするため、
// プリフライト(OPTIONS)と各レスポンスにCORSヘッダーを付与する
// ---------------------------------------------------------------------------
const ALLOWED_ORIGIN = "https://goblin-surfer.github.io";
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-cron-secret, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------------------------------------------------------------------------
// Google OAuth: リフレッシュトークンから都度アクセストークンを取得
// ---------------------------------------------------------------------------
async function getGoogleAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${JSON.stringify(json)}`);
  }
  return json.access_token as string;
}

// ---------------------------------------------------------------------------
// Google Drive API ヘルパー
// ---------------------------------------------------------------------------
function escapeForQuery(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveFetch(accessToken: string, path: string) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Drive API error (${path}): ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function findChildByName(
  accessToken: string,
  parentId: string,
  name: string,
  mimeType?: string,
): Promise<{ id: string; name: string } | null> {
  let q = `'${parentId}' in parents and name = '${escapeForQuery(name)}' and trashed = false`;
  if (mimeType) q += ` and mimeType = '${mimeType}'`;
  const json = await driveFetch(
    accessToken,
    `files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
  );
  return json.files?.[0] ?? null;
}

async function findOrCreateFolder(
  accessToken: string,
  parentId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const existing = await findChildByName(
    accessToken,
    parentId,
    name,
    "application/vnd.google-apps.folder",
  );
  if (existing) return existing;
  const res = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  if (!res.ok) throw new Error(`Drive folder create failed: ${await res.text()}`);
  return res.json();
}

async function listCsvFiles(
  accessToken: string,
  folderId: string,
): Promise<{ id: string; name: string }[]> {
  const q =
    `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
  const json = await driveFetch(
    accessToken,
    `files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
  );
  return json.files ?? [];
}

async function downloadFile(accessToken: string, fileId: string): Promise<Uint8Array> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`Drive download failed: ${res.status} ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function moveFile(
  accessToken: string,
  fileId: string,
  fromParentId: string,
  toParentId: string,
) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${toParentId}&removeParents=${fromParentId}`,
    { method: "PATCH", headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`Drive move failed: ${res.status} ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// CSVパース（csv_import_profiles の設定に従って機械的に列を読み替えるだけ。
// 未知の形式を推測することはしない）
// ---------------------------------------------------------------------------
type Profile = {
  issuer: string;
  encoding: string;
  header_rows_to_skip: number;
  date_column: number;
  date_format: string;
  merchant_column: number;
  amount_column: number;
  memo_column: number | null;
  skip_if_date_empty: boolean;
};

type ParsedRow = { used_date: string; merchant: string; amount: number; memo: string | null };

// 簡易CSV行パーサー（ダブルクォート対応）
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

function normalizeDate(raw: string, format: string): string {
  // "YYYY/MM/DD"（Vpass, アメックス, JCB, SAISON）と
  // "YYYY-MM-DD"（To Me CARD/NICOS）に対応。今後カード会社が増えたら分岐を追加する。
  if (format === "YYYY/MM/DD") {
    const m = raw.trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!m) throw new Error(`日付の形式が想定外です: ${raw}`);
    const [, y, mo, d] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  if (format === "YYYY-MM-DD") {
    const m = raw.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) throw new Error(`日付の形式が想定外です: ${raw}`);
    const [, y, mo, d] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  throw new Error(`未対応の date_format です: ${format}`);
}

type SkippedRow = { raw: string; reason: string };
type ParseResult = { rows: ParsedRow[]; skipped: SkippedRow[] };

function parseCsv(bytes: Uint8Array, profile: Profile): ParseResult {
  const decoder = new TextDecoder(profile.encoding);
  const text = decoder.decode(bytes);
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
  const dataLines = lines.slice(profile.header_rows_to_skip);

  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];

  for (const line of dataLines) {
    const cells = parseCsvLine(line);
    const dateRaw = (cells[profile.date_column] ?? "").trim();
    if (profile.skip_if_date_empty && dateRaw === "") continue; // 合計行などをスキップ
    // 日付欄が全角/半角のダッシュだけの行（カード会社のCSVに混ざる「小計」区切り行など）は
    // 利用明細ではないので、要確認扱いにもせず無条件で読み飛ばす
    if (/^[-－]+$/.test(dateRaw)) continue;

    const merchant = (cells[profile.merchant_column] ?? "").trim();
    const amountRaw = (cells[profile.amount_column] ?? "").trim();
    const amount = Number(amountRaw.replace(/,/g, ""));

    // マイナス金額(返金など)や解釈できない値は、この1行だけスキップして
    // 手入力での確認に回す（1行の異常でファイル全体の取り込みを止めない）
    if (!Number.isFinite(amount) || amount < 0) {
      skipped.push({
        raw: line,
        reason: `要確認(自動取り込み対象外): date=${dateRaw} amount="${amountRaw}"`,
      });
      continue;
    }

    let usedDate: string;
    try {
      usedDate = normalizeDate(dateRaw, profile.date_format);
    } catch (e) {
      skipped.push({ raw: line, reason: errorMessage(e) });
      continue;
    }

    const memo = profile.memo_column != null ? (cells[profile.memo_column] ?? "").trim() || null : null;

    rows.push({ used_date: usedDate, merchant, amount: Math.round(amount), memo });
  }
  return { rows, skipped };
}

// supabase-jsのエラーはErrorのインスタンスとは限らず、そのままStringにすると
// "[object Object]" になってしまうことがあるため、中身を掘り出す
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const anyE = e as Record<string, unknown>;
    const parts = [anyE.message, anyE.details, anyE.hint, anyE.code]
      .filter((v) => v !== undefined && v !== null)
      .map(String);
    if (parts.length > 0) return parts.join(" / ");
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

async function computeImportHash(cardId: string, row: ParsedRow): Promise<string> {
  const src = `${cardId}|${row.used_date}|${row.merchant}|${row.amount}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(src));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// カテゴリ自動分類（merchant_categories をナレッジとして使う）
// 利用先(merchant)に keyword が含まれる行の中から、priority が高いもの
// （同じ priority なら keyword が長い=より具体的なもの）を採用する。
// 一致するルールが無ければ null を返し、list.html 側で人間に判断してもらう。
// ---------------------------------------------------------------------------
type CategoryRule = { keyword: string; category_name: string; priority: number; source: string };
type CategoryResolution = { category: string; source: string };

function resolveCategory(
  rulesByUser: Map<string, CategoryRule[]>,
  userId: string,
  merchant: string,
): CategoryResolution | null {
  const rules = rulesByUser.get(userId);
  if (!rules || rules.length === 0) return null;

  const matches = rules.filter((r) => r.keyword.length > 0 && merchant.includes(r.keyword));
  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.keyword.length - a.keyword.length;
  });
  // source: 人間が確定した('human')キーワードに一致していれば確定扱い。
  // AIが推測して登録した('ai')キーワードに一致した場合は、まだ人間未確認として扱う。
  return { category: matches[0].category_name, source: matches[0].source };
}

// list.html の CATS と必ず同じ内容にすること（手入力・一覧の分類と食い違わないように）
const CATEGORY_LIST = ["食費", "日用品", "水道光熱", "通信", "交通費", "その他"];

// ---------------------------------------------------------------------------
// カテゴリ自動分類（AI判定・任意機能）
// merchant_categories に一致するルールが無い「初めての利用先」だけ、
// Cloudflare Workers AI に推測してもらう。モデルが自信を持って判断できない
// 場合（「不明」や、6カテゴリ以外の出力）はnullを返し、人間の判断に回す。
// APIキー未設定・通信エラー・タイムアウトなど何が起きても例外を投げず、
// 常にnullにフォールバックして取込全体を止めないようにする。
// ---------------------------------------------------------------------------
async function classifyWithAI(merchant: string): Promise<string | null> {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) return null;

  const prompt = `あなたは日本のクレジットカード利用明細を分類するアシスタントです。
次のカテゴリ一覧から最も当てはまるものを一つだけ選び、そのカテゴリ名だけを1行で出力してください。
説明や記号は付けないでください。自信を持って判断できない場合は「不明」と出力してください。

カテゴリ一覧: ${CATEGORY_LIST.join(", ")}

利用先: ${merchant}

カテゴリ:`;

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${CLOUDFLARE_AI_MODEL}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt }),
      },
    );
    if (!res.ok) {
      console.error(`Cloudflare Workers AI error (${res.status}): ${await res.text()}`);
      return null;
    }
    const body = await res.json();
    const raw = String(body?.result?.response ?? "").trim();
    // モデルが指示通り1行だけ返すとは限らないので、1行目だけを見て判定する
    const firstLine = raw.split(/\r?\n/)[0].trim().replace(/^[「"']|[」"']$/g, "");
    return CATEGORY_LIST.includes(firstLine) ? firstLine : null;
  } catch (e) {
    console.error("Cloudflare Workers AI call failed:", errorMessage(e));
    return null;
  }
}

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    // --- 認可チェック ---
    const cronHeader = req.headers.get("x-cron-secret") ?? "";
    const authHeader = req.headers.get("authorization") ?? "";
    let authorized = false;

    if (cronHeader && cronHeader === CRON_SHARED_SECRET) {
      authorized = true;
    } else if (authHeader.toLowerCase().startsWith("bearer ")) {
      const userClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data, error } = await userClient.auth.getUser();
      if (!error && data?.user) authorized = true;
    }

    if (!authorized) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    // ここから先はすべて service_role 相当の権限（RLSを迂回）で実行
    const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

    const accessToken = await getGoogleAccessToken();

    const [
      { data: cards, error: cardsErr },
      { data: profiles, error: profilesErr },
      { data: categoryRuleRows, error: categoryRulesErr },
    ] = await Promise.all([
      admin.from("cards").select("id, user_id, name, issuer").eq("is_active", true),
      admin.from("csv_import_profiles").select("*"),
      admin.from("merchant_categories").select("user_id, keyword, category_name, priority, source"),
    ]);
    if (cardsErr) throw cardsErr;
    if (profilesErr) throw profilesErr;
    if (categoryRulesErr) throw categoryRulesErr;

    const profileByIssuer = new Map<string, Profile>(
      (profiles ?? []).map((p: Profile) => [p.issuer, p]),
    );

    // user_id ごとに「利用先→カテゴリ」のナレッジをまとめておく
    const categoryRulesByUser = new Map<string, CategoryRule[]>();
    for (const r of categoryRuleRows ?? []) {
      const list = categoryRulesByUser.get(r.user_id) ?? [];
      list.push({ keyword: r.keyword, category_name: r.category_name, priority: r.priority, source: r.source ?? "human" });
      categoryRulesByUser.set(r.user_id, list);
    }

    const summary: Record<string, unknown>[] = [];

    for (const card of cards ?? []) {
      // カード用のフォルダが無ければ自動作成する（新しいカードを登録した直後で
      // まだDrive側にフォルダを作っていない場合でも、エラーにも無反応にもしない）
      const folder = await findOrCreateFolder(accessToken, DRIVE_ROOT_FOLDER_ID, card.name);

      const profile = profileByIssuer.get(card.issuer);
      if (!profile) {
        await admin.from("import_logs").insert({
          user_id: card.user_id,
          card_id: card.id,
          status: "error",
          new_count: 0,
          needs_review_count: 0,
          error_message: `未対応のCSV形式です（issuer=${card.issuer}）。csv_import_profilesに設定を追加してください。`,
        });
        summary.push({ card: card.name, error: "no profile" });
        continue;
      }

      const oldFolder = await findOrCreateFolder(accessToken, folder.id, "old");
      const files = await listCsvFiles(accessToken, folder.id);

      if (files.length === 0) {
        // 新しいCSVがない場合も「実行はされた」ことが分かるようログを残す
        await admin.from("import_logs").insert({
          user_id: card.user_id,
          card_id: card.id,
          status: "success",
          new_count: 0,
          needs_review_count: 0,
          source_file_name: null,
          error_message: "新しいCSVファイルはありませんでした。",
        });
        summary.push({ card: card.name, newFiles: 0 });
        continue;
      }

      for (const file of files) {
        try {
          const bytes = await downloadFile(accessToken, file.id);
          const { rows, skipped } = parseCsv(bytes, profile);

          // 1行ずつ順番に処理する（同じ利用先が同じファイル内に複数回出てきたとき、
          // 2回目以降はAI判定を呼ばずにこの場で更新したルールを再利用するため）
          const insertRows: Record<string, unknown>[] = [];
          for (const r of rows) {
            // 1. まずナレッジ（merchant_categories）に一致するか確認
            const resolved = resolveCategory(categoryRulesByUser, card.user_id, r.merchant);
            let category: string | null = resolved?.category ?? null;
            // category_source: 'human' = 人間が確定したキーワードに一致 → 確定扱い。
            // 'ai' = AIが推測しただけ（まだ人間未確認）→ list.html で要確認表示にする。
            let categorySource: string | null = resolved?.source ?? null;

            // 2. 一致しない「初めての利用先」だけ、Cloudflare Workers AIに判定してもらう
            if (!category) {
              const aiCategory = await classifyWithAI(r.merchant);
              if (aiCategory) {
                category = aiCategory;
                categorySource = "ai";

                // 次回以降（このファイル内の後続行も含む）は同じ利用先が
                // AI判定なしで自動分類されるよう、その場でナレッジに記録する
                // （source: 'ai' のまま。人間がlist.htmlで修正・確認すると 'human' に更新される）
                const rules = categoryRulesByUser.get(card.user_id) ?? [];
                rules.push({ keyword: r.merchant, category_name: aiCategory, priority: 0, source: "ai" });
                categoryRulesByUser.set(card.user_id, rules);

                const { error: ruleError } = await admin.from("merchant_categories").upsert(
                  { user_id: card.user_id, keyword: r.merchant, category_name: aiCategory, priority: 0, source: "ai" },
                  { onConflict: "user_id,keyword" },
                );
                // ナレッジ登録に失敗しても、この行のカテゴリ設定自体は成立しているので
                // 取込全体は止めず、ログだけ残す
                if (ruleError) {
                  console.error("merchant_categories upsert (AI) failed:", errorMessage(ruleError));
                }
              }
              // AIも「不明」や想定外の出力だった場合は category は null のまま
              // → list.html で「カテゴリ未設定」として人間の判断に回る
            }

            insertRows.push({
              user_id: card.user_id,
              card_id: card.id,
              used_date: r.used_date,
              amount: r.amount,
              merchant: r.merchant,
              category,
              category_source: categorySource,
              memo: r.memo,
              status: "confirmed",
              source: "auto",
              import_hash: await computeImportHash(card.id, r),
            });
          }

          let newCount = 0;
          if (insertRows.length > 0) {
            const { data: inserted, error } = await admin
              .from("card_statements")
              .upsert(insertRows, { onConflict: "import_hash", ignoreDuplicates: true })
              .select("id");
            if (error) throw error;
            newCount = inserted?.length ?? 0;
          }

          await moveFile(accessToken, file.id, folder.id, oldFolder.id);

          const skippedNote = skipped.length > 0
            ? `${skipped.length}件の行を要確認としてスキップしました（手入力での確認・登録をお願いします）: ` +
              skipped.map((s) => s.reason).join(" / ")
            : null;

          await admin.from("import_logs").insert({
            user_id: card.user_id,
            card_id: card.id,
            status: "success",
            new_count: newCount,
            needs_review_count: newCount,
            source_file_name: file.name,
            error_message: skippedNote,
          });
          summary.push({ card: card.name, file: file.name, newCount, skipped: skipped.length });
        } catch (e) {
          await admin.from("import_logs").insert({
            user_id: card.user_id,
            card_id: card.id,
            status: "error",
            new_count: 0,
            needs_review_count: 0,
            source_file_name: file.name,
            error_message: errorMessage(e).slice(0, 500),
          });
          summary.push({ card: card.name, file: file.name, error: errorMessage(e).slice(0, 200) });
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, summary }), {
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: errorMessage(e).slice(0, 500) }), {
      status: 500,
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }
});
