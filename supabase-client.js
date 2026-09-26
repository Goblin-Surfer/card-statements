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
