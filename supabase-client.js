// Supabase接続設定・認証まわりの共通処理
// index.html を含む全ページで、supabase-js の <script> タグの直後にこのファイルを読み込みます。
//
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="./supabase-client.js"></script>
//
// Project URL / Publishable key はどちらも公開して問題ない値です。
// （service_role key と DBパスワードは絶対にここに書かないでください）

const SUPABASE_URL = 'https://mseghmciousmjhcoqgrx.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TB-_jbZDU_KexsSWqTuDBg_wnFWSRGf';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ログイン画面（index.html）以外の各ページの先頭で呼び出す。
// ログインしていなければ index.html に戻し、null を返す。
async function requireAuth() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = './index.html';
    return null;
  }
  return session;
}

async function logout() {
  await supabaseClient.auth.signOut();
  window.location.href = './index.html';
}

// カテゴリ一覧の取得・新規作成（list.html / input.html / knowledge.html で共通利用）
async function fetchCategories() {
  const { data, error } = await supabaseClient
    .from('categories')
    .select('id, name, sort_order')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

// 新しいカテゴリを作成する。同名カテゴリが既にあればそれをそのまま返す（エラーにしない）。
async function createCategory(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { error: new Error('カテゴリ名を入力してください') };

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return { error: new Error('認証が切れています。再度ログインしてください。') };

  const { data, error } = await supabaseClient
    .from('categories')
    .insert({ user_id: session.user.id, name: trimmed })
    .select('id, name, sort_order')
    .single();

  if (!error) return { data };

  // unique_violation: 既に同名カテゴリがあるので、それを取得して返す
  if (error.code === '23505') {
    const { data: existing, error: fetchError } = await supabaseClient
      .from('categories')
      .select('id, name, sort_order')
      .eq('user_id', session.user.id)
      .eq('name', trimmed)
      .maybeSingle();
    if (!fetchError && existing) return { data: existing };
  }

  return { error };
}

// 中分類（subcategories）の取得・新規作成。中分類は大分類（categories.name）ごとに持つ。
async function fetchSubcategories() {
  const { data, error } = await supabaseClient
    .from('subcategories')
    .select('id, category_name, name, sort_order')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function createSubcategory(categoryName, name) {
  const trimmed = (name || '').trim();
  if (!categoryName) return { error: new Error('先に大分類を選んでください') };
  if (!trimmed) return { error: new Error('中分類の名前を入力してください') };

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return { error: new Error('認証が切れています。再度ログインしてください。') };

  const { data, error } = await supabaseClient
    .from('subcategories')
    .insert({ user_id: session.user.id, category_name: categoryName, name: trimmed })
    .select('id, category_name, name, sort_order')
    .single();
  if (!error) return { data };

  if (error.code === '23505') {
    const { data: existing, error: fetchError } = await supabaseClient
      .from('subcategories')
      .select('id, category_name, name, sort_order')
      .eq('user_id', session.user.id)
      .eq('category_name', categoryName)
      .eq('name', trimmed)
      .maybeSingle();
    if (!fetchError && existing) return { data: existing };
  }
  return { error };
}

// 中分類の <option> 群（大分類が未選択なら空）。selected が一覧にない場合も選択肢として残す。
function subcategoryOptionsHtml(subcategories, categoryName, selected) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  const list = subcategories.filter((s) => s.category_name === categoryName).map((s) => s.name);
  if (selected && !list.includes(selected)) list.push(selected);
  return `<option value="" ${selected ? '' : 'selected'}>（中分類なし）</option>` +
    list.map((n) => `<option value="${esc(n)}" ${n === selected ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

// 利用先名の表記ゆれを落とした「読みやすい名前」と、月をまたいで同じ店をまとめるためのキー
//  - 全角→半角、半角の濁点、括弧書き（（翌月買付分）〔ネット〕など）を除く
//  - 末尾の所在地（「東京都 渋谷区」「?千葉県」など）を除く
//  - 2語目以降の請求番号・URL（「P46AF39499 684488」「WWW.AMAZON.CO」など）を除く
function cleanMerchant(s) {
  let t = String(s || '').normalize('NFKC')
    .replace(/\s?([゙゚])/g, '$1').normalize('NFC')
    .replace(/[(\[〔【「][^)\]〕】」]*[)\]〕】」]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  t = t.replace(/\s+\?*\s*(北海道|東京都|京都府|大阪府|\S{2,3}県)(\s.*)?$/, '');
  const words = t.split(' ');
  const isCode = (w) => /\d{3,}/.test(w) || /\.\w{2,}/.test(w)
    || (/^[A-Z0-9]{5,}$/i.test(w) && (w.match(/\d/g) || []).length >= 2);
  t = [words[0], ...words.slice(1).filter((w) => !isCode(w))].join(' ');
  t = t.replace(/([ァ-ヶ])-(?=[ァ-ヶ])/g, '$1ー');
  return t.replace(/\s*\?+$/, '').trim() || String(s || '').trim();
}
function merchantKey(s) {
  return cleanMerchant(s).replace(/\s+/g, '').replace(/[-‐−ｰ]/g, 'ー').toUpperCase();
}
function merchantLabel(s) {
  const t = cleanMerchant(s);
  return t.length > 22 ? t.slice(0, 21) + '…' : t;
}
