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
