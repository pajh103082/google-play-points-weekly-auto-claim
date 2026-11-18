const LABEL = {
  new: '… 本週還沒檢查',
  claimed: '✅ 已領取',
  already: '☑ 本週已領過',
  claimable: '可以領（還沒按）',
  unverified: '⚠ 按了領取，但沒確認到',
  app_only: '⚠ 網頁不能領，要用 App',
  no_prize: '－ 沒有每週獎勵',
  not_open: '⏳ 還沒開放（等等會再試）',
  not_member: '－ 沒加入 Play Points',
  notfound: '⚠ 找不到每週獎勵（可能改版）',
  login: '⚠ 這個 Chrome 沒登入 Google',
  timeout: '⚠ 頁面載入逾時',
  error: '❌ 發生錯誤'
};
const OK = ['claimed', 'already', 'no_prize', 'not_member'];
const SPONSOR_URL = 'https://ko-fi.com/sagiriben';

function weekKey(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - ((d.getDay() - 5 + 7) % 7));
  return d.toLocaleDateString('sv-SE');
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function render() {
  const s = await chrome.storage.local.get(['week', 'accounts', 'log', 'runningSince']);
  const wk = weekKey();
  const acc = s.week === wk ? (s.accounts || {}) : {};
  const list = Object.entries(acc).sort((a, b) => (a[1].authuser ?? 99) - (b[1].authuser ?? 99));
  const done = list.filter(([, a]) => OK.includes(a.status)).length;
  const wait = (st) => st === 'no_prize' || st === 'not_member';
  const [, m, d] = wk.split('-');
  document.getElementById('week').textContent = list.length
    ? `本週（${+m}/${+d} 週五起）：${done} / ${list.length} 個帳號完成`
    : `本週（${+m}/${+d} 週五起）：還沒檢查過`;

  const table = document.getElementById('accounts');
  table.innerHTML = '';
  for (const [email, a] of list) {
    const tr = el('tr');
    const left = el('td');
    const note = a.neverSince ? `（從 ${a.neverSince} 那週起確認領不到，不用每週重查）` : '';
    left.append(el('div', '', email), el('div', 't', `${a.time || ''}　${a.info || ''}${note}`));
    const right = el('td', 'st ' + (wait(a.status) ? 'wait' : OK.includes(a.status) ? 'ok' : 'bad'), LABEL[a.status] || a.status);
    tr.append(left, right);
    table.append(tr);
  }

  const ul = document.getElementById('log');
  ul.innerHTML = '';
  for (const item of (s.log || []).slice(0, 15)) {
    const li = el('li');
    li.append(el('div', 't', `${item.time}　${item.email}`),
      el('div', '', (LABEL[item.status] || item.status) + (item.text ? '：' + item.text : '')));
    ul.append(li);
  }

  const btn = document.getElementById('run');
  const running = s.runningSince && Date.now() - s.runningSince < 600000;
  btn.disabled = !!running;
  btn.textContent = running ? '執行中…（一個帳號約 10 秒）' : '立即檢查並領取';
}

document.getElementById('run').addEventListener('click', async () => {
  const btn = document.getElementById('run');
  btn.disabled = true;
  btn.textContent = '執行中…（一個帳號約 10 秒）';
  await chrome.runtime.sendMessage({ cmd: 'run' });
  render();
});

document.getElementById('sponsorBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: SPONSOR_URL });
  window.close();
});

const only = document.getElementById('onlyEmails');
chrome.storage.local.get(['onlyEmails']).then((s) => { only.value = s.onlyEmails || ''; });
only.addEventListener('input', () => chrome.storage.local.set({ onlyEmails: only.value }));

chrome.storage.onChanged.addListener(render);
render();
