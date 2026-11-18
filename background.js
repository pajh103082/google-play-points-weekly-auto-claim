// Google Play 每週獎勵自動領取（Chrome 擴充功能 MV3）
//
// 做法：在背景分頁打開 https://play.google.com/store/points/perks?authuser=N
//       （N = 0,1,2… 就是 Chrome 裡登入的第幾個 Google 帳號），
//       找「每週獎勵」卡片裡的「領取」按鈕：disabled＝本週領過；可以按＝按下去，再重新整理確認變成 disabled。
// 排程：每 30 分鐘醒來看一次，週五 00:05 起一直到下週四（整週）、距上次執行超過 2 小時、
//       而且還有帳號沒處理完才真的跑；Chrome 啟動時有沒處理完的帳號也會補跑。沒有次數上限（v1.1）。
// 狀態檔：每次狀態改變就把「本週處理完了沒」寫到 下載資料夾\Chrome插件狀態\google_play_weekly.json，
//       讓開機腳本（蝦皮插件的 開機自動開啟Chrome\open_chrome.ps1）決定要不要開 Chrome。

const PERKS_URL = 'https://play.google.com/store/points/perks?hl=zh_TW&authuser=';
const MAX_ACCOUNTS = 20;          // 最多檢查到 authuser=19（超過登入數量時 Google 會一直回最後一個帳號，靠 seen 判斷停止）
const MAX_TRIES = Infinity;       // 使用者要求整週不停止重試（v1.1；之前是 12）
const RUN_GAP_MIN = 110;          // 自動執行的最短間隔（分鐘）
const LOCK_MS = 10 * 60 * 1000;   // 一次執行最久約幾分鐘，鎖住避免重複
const LOG_LIMIT = 40;
// 算「本週處理完」、不用再試的狀態。no_prize = 獎勵分頁寫「升級後解鎖的獎勵會顯示在這裡」（沒有每週獎勵）；
// not_member = 還沒加入 Play Points（只看到「免費加入」）
const DONE = ['claimed', 'already', 'app_only', 'no_prize', 'not_member'];
const OK = ['claimed', 'already', 'no_prize', 'not_member'];   // 徽章與通知不當成問題的狀態

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (d = new Date()) =>
  d.toLocaleDateString('sv-SE') + ' ' + d.toTimeString().slice(0, 5);

// 最近一個週五（含今天）的日期 YYYY-MM-DD，當作「本週」
function weekKey(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - ((d.getDay() - 5 + 7) % 7));
  return d.toLocaleDateString('sv-SE');
}

// 自動領取時段：週五 00:05 起到下週四 23:59（整週）。只避開週五 00:00～00:05 剛換週的那幾分鐘
function inWindow(now = new Date()) {
  return !(now.getDay() === 5 && now.getHours() === 0 && now.getMinutes() < 5);
}

const STATUS_FILE = 'Chrome插件狀態/google_play_weekly.json';

function setupAlarm() {
  chrome.alarms.create('gp-tick', { delayInMinutes: 1, periodInMinutes: 30 });
}

chrome.runtime.onInstalled.addListener(() => {
  setupAlarm();
  refreshBadge();
  writeStatus(true);
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
  refreshBadge();
  writeStatus(false);
  maybeRun(false, 'startup');
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'gp-tick') maybeRun(false, 'alarm');
});

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg && msg.cmd === 'run') {
    maybeRun(true, 'manual').then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function loadState() {
  const s = await chrome.storage.local.get(['week', 'accounts', 'log', 'lastRun', 'runningSince', 'onlyEmails']);
  const wk = weekKey();
  if (s.week !== wk) {
    s.week = wk;
    s.accounts = {};
    await chrome.storage.local.set({ week: wk, accounts: {} });
  }
  s.accounts = s.accounts || {};
  s.log = s.log || [];
  return s;
}

function pendingEmails(s) {
  const list = Object.entries(s.accounts);
  if (list.length === 0) return ['(尚未偵測帳號)'];
  return list
    .filter(([e, a]) => !DONE.includes(a.status) && (a.tries || 0) < MAX_TRIES && allowed(s, e))
    .map(([e]) => e);
}

function allowed(s, email) {
  const only = (s.onlyEmails || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  return only.length === 0 || only.includes(email.toLowerCase());
}

async function maybeRun(force, reason) {
  const s = await loadState();
  if (s.runningSince && Date.now() - s.runningSince < LOCK_MS) return;
  if (!force) {
    if (pendingEmails(s).length === 0) return;
    if (reason !== 'startup' && !inWindow()) return;
    if (s.lastRun && Date.now() - s.lastRun < RUN_GAP_MIN * 60000) return;
  }
  await chrome.storage.local.set({ runningSince: Date.now(), lastRun: Date.now() });
  try {
    await run(force);
  } catch (e) {
    await addLog('—', 'error', String(e && e.message ? e.message : e));
  } finally {
    await chrome.storage.local.set({ runningSince: 0 });
    await refreshBadge();
    await writeStatus(false);
  }
}

async function run(force) {
  let tabId = null;
  let ownWindowId = null;
  const results = [];
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (wins.length === 0) {
      const w = await chrome.windows.create({ url: 'about:blank', state: 'minimized', focused: false });
      ownWindowId = w.id;
      tabId = w.tabs[0].id;
    } else {
      tabId = (await chrome.tabs.create({ url: 'about:blank', active: false })).id;
    }

    const seen = new Set();
    for (let n = 0; n < MAX_ACCOUNTS; n++) {
      const r = await inspect(tabId, n, false);
      if (r.status === 'login' || !r.email) {
        if (n === 0) await addLog('—', r.status === 'login' ? 'login' : r.status, r.info || '');
        break; // 沒有更多登入的帳號
      }
      if (seen.has(r.email)) break; // authuser 超過登入數量時會回到第一個帳號
      seen.add(r.email);

      const s = await loadState();
      if (!allowed(s, r.email)) continue;
      const a = s.accounts[r.email] || { tries: 0 };
      if (!force && DONE.includes(a.status)) continue;
      if (!force && (a.tries || 0) >= MAX_TRIES) continue;

      let final = r;
      if (r.status === 'claimable') {
        const c = await inspect(tabId, n, true);
        if (c.status === 'clicked') {
          const v = await inspect(tabId, n, false); // 重新整理後確認按鈕變灰
          final = (v.status === 'already' || v.status === 'not_open')   // 按完之後按鈕變灰就算領到
            ? { ...v, status: 'claimed', info: c.result || v.info }
            : { ...v, status: 'unverified', info: (c.result ? c.result + '；' : '') + '重新整理後按鈕沒有變灰' };
        } else {
          final = c;
        }
      }
      a.tries = (a.tries || 0) + 1;
      a.status = final.status;
      a.info = final.info || '';
      a.time = fmt();
      a.authuser = n;
      s.accounts[r.email] = a;
      await chrome.storage.local.set({ accounts: s.accounts });
      await addLog(r.email, final.status, final.info || '');
      results.push([r.email, final.status]);
    }
  } finally {
    if (ownWindowId !== null) {
      try { await chrome.windows.remove(ownWindowId); } catch (_) {}
    } else if (tabId !== null) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
  }
  notifyIfNeeded(results);
}

async function inspect(tabId, n, doClaim) {
  if (!doClaim) {
    await chrome.tabs.update(tabId, { url: PERKS_URL + n });
    if (!(await waitComplete(tabId, 30000))) return { status: 'timeout', info: '頁面 30 秒內沒載完' };
  }
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: perksPage, args: [doClaim] });
  return (res && res.result) || { status: 'error', info: '沒有回傳結果' };
}

// ↓ 這個函式會被注入到 Play Points 網頁裡執行，必須自己完整、不能用外面的變數
async function perksPage(doClaim) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const APP_ONLY = /無法在這裡使用|Android 裝置上透過 Play 商店|can't use this|Android device/i;
  const NO_PRIZE = /升級後解鎖的獎勵會顯示在這裡|rewards you unlock .*will (show|appear) here/i;
  const isNotMember = () => [...document.querySelectorAll('button,a,[role="button"]')]
    .some((b) => /^(免費加入|立即加入|Join for free|Join now)$/i.test(clean(b.textContent)));

  const emailOf = () => {
    for (const el of document.querySelectorAll('[aria-label]')) {
      const l = el.getAttribute('aria-label') || '';
      if (/Google 帳戶|Google Account/i.test(l)) {
        const m = l.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
        if (m) return m[0];
      }
    }
    return '';
  };
  const findWeekly = () => {
    const h = [...document.querySelectorAll('h1,h2,h3,h4,div,span')].find(
      (e) => e.childElementCount === 0 && /^(每週獎勵|Weekly prize)/i.test(clean(e.textContent)));
    if (!h) return null;
    let c = h.parentElement;
    for (let i = 0; i < 8 && c; i++) {
      const b = [...c.querySelectorAll('button')].find((x) => /領取|Claim|Collect/i.test(x.textContent));
      if (b) return { card: c, btn: b };
      c = c.parentElement;
    }
    return { card: null, btn: null };
  };
  const isDisabled = (b) => b.disabled || b.getAttribute('aria-disabled') === 'true' || b.hasAttribute('inert');

  if (/accounts\.google\.com/.test(location.href)) return { status: 'login', info: '這個 Chrome 沒有登入 Google' };
  // 沒加入 Play Points 的帳號，打開 perks 會被轉到 /store/points/enroll
  if (/\/points\/enroll/.test(location.pathname)) {
    await sleep(500);
    return { status: 'not_member', email: emailOf(), info: '這個帳號還沒加入 Play Points' };
  }

  let w = null;
  let other = '';   // 'no_prize' / 'not_member' / 'app_only'：確定沒有每週獎勵，不用等滿 15 秒
  for (let i = 0; i < 30; i++) {
    w = findWeekly();
    if (w && w.btn) break;
    const txt = document.body.innerText;
    if (APP_ONLY.test(txt)) { other = 'app_only'; break; }
    if (NO_PRIZE.test(txt) || isNotMember()) {
      await sleep(1000);              // 多等 1 秒，確定每週獎勵卡片不是晚一點才出現
      w = findWeekly();
      if (w && w.btn) break;
      other = isNotMember() ? 'not_member' : 'no_prize';
      break;
    }
    await sleep(500);
  }
  const email = emailOf();
  const cardText = (x) => clean(x && x.card ? x.card.innerText : '').replace(/^每週獎勵\s*/, '').replace(/lock\s*/g, '').slice(0, 80);

  if (!w || !w.btn) {
    if (other === 'not_member') return { status: 'not_member', email, info: '這個帳號還沒加入 Play Points' };
    if (other === 'no_prize') return { status: 'no_prize', email, info: '獎勵分頁寫「升級後解鎖的獎勵會顯示在這裡」' };
    if (other === 'app_only' || APP_ONLY.test(document.body.innerText)) return { status: 'app_only', email, info: '網頁要求改用 Android 的 Play 商店 App 領取' };
    return { status: 'notfound', email, info: '找不到每週獎勵卡片（可能改版）' };
  }
  const info = cardText(w);
  if (isDisabled(w.btn)) {
    // 灰色按鈕有兩種：「下一份獎勵還沒開放」和「本週領過了」，畫面一樣，都寫「推出日期：M月D日」。
    // 日期在今天之後 → 本週的已領過（等下一份）；日期是今天或更早 → 本週的還沒開放，等等再試。
    const m = info.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (m) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let rel = new Date(now.getFullYear(), +m[1] - 1, +m[2]);
      if (rel - today > 180 * 864e5) rel = new Date(now.getFullYear() - 1, +m[1] - 1, +m[2]);
      if (rel - today < -180 * 864e5) rel = new Date(now.getFullYear() + 1, +m[1] - 1, +m[2]);
      if (rel <= today) return { status: 'not_open', email, info };
    }
    return { status: 'already', email, info };
  }
  if (!doClaim) return { status: 'claimable', email, info };

  w.btn.click();
  await sleep(4000);
  let result = '';
  for (let k = 0; k < 3; k++) {
    const dlg = document.querySelector('[role="dialog"],[role="alertdialog"],[aria-modal="true"]');
    const txt = clean(dlg ? dlg.innerText : document.body.innerText);
    if (APP_ONLY.test(txt)) return { status: 'app_only', email, info: '網頁要求改用 Android 的 Play 商店 App 領取' };
    if (!dlg) break;
    result = txt.slice(0, 120);
    // 有得選就選 Play 點數；再按領取／確定類的按鈕
    const pick = [...dlg.querySelectorAll('button,[role="button"],[role="radio"]')].find((x) => /Play 點數|Play Points/.test(x.textContent));
    if (pick && k === 0) { pick.click(); await sleep(1500); }
    const b = [...dlg.querySelectorAll('button')].find((x) => !isDisabled(x) && /領取|Claim|確定|完成|知道了|關閉|OK|Done|Got it/i.test(x.textContent));
    if (!b) break;
    b.click();
    await sleep(3000);
  }
  return { status: 'clicked', email, info, result };
}

function waitComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function addLog(email, status, text) {
  const s = await chrome.storage.local.get(['log']);
  const log = s.log || [];
  log.unshift({ time: fmt(), email, status, text });
  await chrome.storage.local.set({ log: log.slice(0, LOG_LIMIT) });
}

function notifyIfNeeded(results) {
  const claimed = results.filter(([, st]) => st === 'claimed').map(([e]) => e);
  const bad = results.filter(([, st]) => !OK.includes(st));
  if (claimed.length === 0 && bad.length === 0) return;
  const lines = [];
  if (claimed.length) lines.push(`已領取：${claimed.join('、')}`);
  if (bad.length) lines.push(`要看一下：${bad.map(([e, st]) => `${e}（${STATUS_TEXT[st] || st}）`).join('、')}`);
  chrome.notifications.create('gp-' + Date.now(), {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Google Play 每週獎勵',
    message: lines.join('\n')
  });
}

const STATUS_TEXT = {
  claimed: '已領取', already: '本週已領過', claimable: '可以領', unverified: '按了領取但沒確認到',
  no_prize: '這個帳號沒有每週獎勵', not_member: '沒加入 Play Points', not_open: '每週獎勵還沒開放',
  app_only: '網頁不能領，要用 App', notfound: '找不到每週獎勵', login: '沒登入 Google', timeout: '載入逾時', error: '錯誤'
};

async function refreshBadge() {
  const s = await loadState();
  const list = Object.entries(s.accounts).filter(([e]) => allowed(s, e));
  const bad = list.filter(([, a]) => !OK.includes(a.status));
  if (list.length && bad.length === 0) {
    await chrome.action.setBadgeText({ text: '✓' });
    await chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
  } else if (bad.length) {
    await chrome.action.setBadgeText({ text: String(bad.length) });
    await chrome.action.setBadgeBackgroundColor({ color: inWindow() ? '#c62828' : '#757575' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// ---------- 狀態檔（給開機腳本看） ----------
// 用 chrome.downloads 把 JSON 存到「下載資料夾\Chrome插件狀態\」。存的時候暫時關掉下載列、存完從下載紀錄刪掉，
// 所以使用者不會看到下載通知（檔案本身會留著）。內容沒變就不重存。
async function writeStatus(force) {
  try {
    const s = await loadState();
    const list = Object.entries(s.accounts).filter(([e]) => allowed(s, e));
    const pending = list.filter(([, a]) => !DONE.includes(a.status)).map(([e]) => e);
    const obj = { week: s.week, allDone: list.length > 0 && pending.length === 0, accounts: list.length, pending: pending.length };
    const key = JSON.stringify(obj);
    const prev = (await chrome.storage.local.get(['statusWritten'])).statusWritten;
    if (!force && prev === key) return;
    obj.updated = fmt();
    if (await saveJsonFile(STATUS_FILE, obj)) await chrome.storage.local.set({ statusWritten: key });
  } catch (e) {
    console.warn('寫狀態檔失敗', e);
  }
}

async function saveJsonFile(path, obj) {
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(obj, null, 2));
  let id = null;
  try {
    try { await chrome.downloads.setUiOptions({ enabled: false }); } catch (_) {}
    id = await chrome.downloads.download({ url, filename: path, conflictAction: 'overwrite', saveAs: false });
    return await waitDownload(id, 15000);
  } catch (e) {
    console.warn('存檔失敗', e);
    return false;
  } finally {
    if (id !== null) { try { await chrome.downloads.erase({ id }); } catch (_) {} }
    try { await chrome.downloads.setUiOptions({ enabled: true }); } catch (_) {}
  }
}

function waitDownload(id, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    function listener(d) {
      if (d.id === id && d.state) {
        if (d.state.current === 'complete') finish(true);
        if (d.state.current === 'interrupted') finish(false);
      }
    }
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id }).then(([it]) => {   // 可能在掛上 listener 前就存好了
      if (it && it.state === 'complete') finish(true);
      if (it && it.state === 'interrupted') finish(false);
    });
  });
}
