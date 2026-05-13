import { signInWithGoogle, userInfo, signOut } from '../core/auth.js';
import { isFirebaseConfigured } from '../core/firebase.js';

export function renderSetupRequiredScreen(app) {
  app.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'auth-screen';
  wrap.innerHTML = `
    <div class="auth-card">
      <h1>KABUKU Editor</h1>
      <p>Firebase 設定が見つかりません。</p>
      <ol class="setup-steps">
        <li>Firebase Console でプロジェクトを作成</li>
        <li>Authentication で Google サインインを有効化</li>
        <li>Firestore Database と Storage を作成</li>
        <li>ウェブアプリ設定から API キー等を取得</li>
        <li>プロジェクトルートに <code>.env</code> を作成し、<code>.env.example</code> の項目を埋める</li>
        <li>
          Storage バケットに CORS 設定（リポジトリ同梱の <code>cors.json</code>）を適用:<br>
          <code>gsutil cors set cors.json gs://&lt;bucket&gt;</code>
        </li>
        <li>開発サーバーを再起動</li>
      </ol>
    </div>
  `;
  app.appendChild(wrap);
}

export function renderLoginScreen(app, onSignedIn) {
  app.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'auth-screen';
  const card = document.createElement('div');
  card.className = 'auth-card';
  const h1 = document.createElement('h1');
  h1.textContent = 'KABUKU Editor';
  const p = document.createElement('p');
  p.textContent = 'Google アカウントでサインインしてください。';
  const btn = document.createElement('button');
  btn.className = 'tool-btn auth-signin-btn';
  btn.textContent = 'Google でサインイン';
  const errEl = document.createElement('div');
  errEl.className = 'auth-error';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    errEl.textContent = '';
    try {
      const user = await signInWithGoogle();
      onSignedIn?.(user);
    } catch (e) {
      console.error(e);
      errEl.textContent = `サインインに失敗しました: ${e.message || e.code || e}`;
    } finally {
      btn.disabled = false;
    }
  });
  card.appendChild(h1);
  card.appendChild(p);
  card.appendChild(btn);
  card.appendChild(errEl);
  wrap.appendChild(card);
  app.appendChild(wrap);
}

/** Compact user badge for the page header. Click to sign out. */
export function createUserBadge() {
  const info = userInfo();
  const wrap = document.createElement('div');
  wrap.className = 'user-badge';
  if (!info) return wrap;
  const label = document.createElement('span');
  label.className = 'user-badge-label';
  label.textContent = info.name;
  const out = document.createElement('button');
  out.type = 'button';
  out.className = 'user-badge-signout';
  out.title = 'Sign out';
  out.textContent = 'Sign out';
  out.addEventListener('click', async () => {
    await signOut();
    location.reload();
  });
  wrap.appendChild(label);
  wrap.appendChild(out);
  return wrap;
}

export { isFirebaseConfigured };
