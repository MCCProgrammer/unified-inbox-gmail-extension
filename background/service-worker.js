/* ================================================================
   UNIFIED INBOX — Background Service Worker
   OAuth (multi-account) & Gmail API Sync Engine
   ================================================================ */

import { getClientId, isClientId } from './config.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'email',
  'profile'
];
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD_API = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
const LOAD_MORE_STEP = 500;
const INBOX_LIMIT = 500;         // conversations per account (whole inbox up to this)
const SYNC_PERIOD_MINUTES = 2;
const FETCH_CONCURRENCY = 6;
const ACCOUNT_COLORS = ['#1a73e8', '#188038', '#9334e6', '#e8710a', '#12a4af', '#d93025', '#e52592', '#f9ab00'];

const CONFIG_HELP =
  'Sign-in is not set up: open the extension popup and paste the OAuth client ID from your own Google ' +
  `Cloud project (a "Web application" client with the redirect URI ${chrome.identity.getRedirectURL()}).`;

const MISSING_SCOPE_HELP =
  'The account was connected without permission to access Gmail. Add it again and, on the Google screen, ' +
  'tick "Read, compose, send and permanently delete all your email from Gmail" (or "Select all").';

class ReauthError extends Error {}

// ─── Lifecycle ───────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  await migrateStorage();
  await ensureAlarm();
  await restoreItemAlarms();
  await updateBadge();
  syncAll().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await restoreItemAlarms();
  await updateBadge();
  syncAll().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  // Item alarms are only for precision; processDue() also runs on every sync
  if (alarm.name === 'sync') syncAll().finally(() => processDue().catch(() => {}));
  else processDue().catch(() => {});
});

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  const [kind, key] = id.split('|');
  openInGmail(kind === 'thread' && key ? `#allinboxes/all/${encodeURIComponent(key)}` : '#allinboxes');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.accounts) updateBadge();
});

async function ensureAlarm() {
  const existing = await chrome.alarms.get('sync');
  if (!existing) chrome.alarms.create('sync', { periodInMinutes: SYNC_PERIOD_MINUTES });
}

// v1.0 stored tokens with the account and message-based emails
async function migrateStorage() {
  const { accounts = [], unifiedEmails = [] } = await chrome.storage.local.get(['accounts', 'unifiedEmails']);
  const cleanAccounts = accounts.map(({ token, expiresAt, inboxMode, authType, ...a }) => a);
  const cleanEmails = unifiedEmails.every(e => e.key) ? unifiedEmails : [];
  await chrome.storage.local.set({ accounts: cleanAccounts, unifiedEmails: cleanEmails });
  await chrome.storage.local.remove(['refreshTokens', 'scheduled']);
  for (const alarm of await chrome.alarms.getAll()) if (alarm.name.startsWith('send:')) chrome.alarms.clear(alarm.name);
}

async function updateBadge() {
  const { accounts = [] } = await chrome.storage.local.get('accounts');
  const total = accounts.reduce((sum, a) => sum + (a.inboxUnread || 0), 0);
  const needsReauth = accounts.some(a => a.needsReauth);
  await chrome.action.setBadgeBackgroundColor({ color: needsReauth ? '#d93025' : '#0b57d0' });
  await chrome.action.setBadgeText({ text: needsReauth ? '!' : total > 0 ? (total > 999 ? '999+' : String(total)) : '' });
}

// ─── Messaging Router ────────────────────────────────────────────
const handlers = {
  GET_UNIFIED_DATA: async () => {
    const { accounts = [], unifiedEmails = [], lastSync = 0 } = await chrome.storage.local.get(['accounts', 'unifiedEmails', 'lastSync']);
    return { accounts, emails: unifiedEmails, lastSync };
  },
  GET_CONFIG: async () => ({ multiAccount: await hasWebClient(), redirectUrl: chrome.identity.getRedirectURL() }),
  AUTH_ADD_ACCOUNT: async (msg) => addAccount({ loginHint: msg.loginHint }),
  SYNC_ALL_EMAILS: async () => {
    const errors = await syncAll();
    const { unifiedEmails = [] } = await chrome.storage.local.get('unifiedEmails');
    if (errors.length) return { success: false, error: errors.join('; '), emails: unifiedEmails };
    return { emails: unifiedEmails };
  },
  UPDATE_ACCOUNT: async (msg) => ({ account: await updateAccount(msg.accountId, msg.updates || {}) }),
  REMOVE_ACCOUNT: async (msg) => { await removeAccount(msg.accountId); return {}; },
  REORDER_ACCOUNTS: async (msg) => {
    const order = Array.isArray(msg.order) ? msg.order : [];
    await updateLocal(['accounts'], ({ accounts = [] }) => {
      const byId = new Map(accounts.map(a => [a.id, a]));
      const ordered = order.map(id => byId.get(id)).filter(Boolean);
      accounts.forEach(a => { if (!order.includes(a.id)) ordered.push(a); });
      return { accounts: ordered };
    });
    return {};
  },
  THREAD_ACTION: async (msg) => threadAction(msg.items || [], msg.action, msg.labelId),
  SEND_MESSAGE: async (msg) => {
    const sent = await sendMessage(msg);
    if (msg.followupDays) await setFollowup({ accountId: msg.accountId, threadId: sent.threadId, subject: msg.subject, days: msg.followupDays });
    return sent;
  },
  CREATE_DRAFT: async (msg) => ({ draft: await createDraft(msg.payload) }),
  SNOOZE: async (msg) => snooze(msg.items || [], msg.until),
  UNSNOOZE: async (msg) => { await unsnooze(msg.key, { notify: false }); return {}; },
  SET_FOLLOWUP: async (msg) => ({ item: await setFollowup(msg) }),
  CANCEL_ITEM: async (msg) => { await cancelItem(msg.kind, msg.id); return {}; },
  GET_SEND_AS: async (msg) => ({ sendAs: await getSendAs(await getAccountById(msg.accountId)).catch(() => null) }),
  LOAD_MORE: async (msg) => loadMore(msg.accountIds),
  LABEL_CREATE: async (msg) => ({ label: await labelCreate(msg.accountId, msg.name, msg.color) }),
  LABEL_UPDATE: async (msg) => { await labelUpdate(msg.accountId, msg.labelId, msg.name, msg.color); return {}; },
  LABEL_DELETE: async (msg) => { await labelDelete(msg.accountId, msg.labelId); return {}; },
  SEARCH: async (msg) => searchAll(String(msg.query || '').trim(), { accountIds: msg.accountIds, inView: !!msg.inView }),
  GET_THREAD_TEXT: async (msg) => ({ text: await getThreadText(msg.accountId, msg.threadId) }),
  GET_THREAD: async (msg) => ({ thread: await getThread(msg.accountId, msg.threadId) }),
  GET_ATTACHMENT: async (msg) => ({ data: await getAttachment(msg.accountId, msg.messageId, msg.attachmentId) }),
  UNSUBSCRIBE: async (msg) => unsubscribe(msg.accountId, msg.threadId)
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message)
    .then(result => sendResponse({ success: true, ...result }))
    .catch(err => {
      console.warn(`[Unified Inbox] ${message.type} failed:`, err);
      sendResponse({ success: false, error: err.message, needsReauth: err instanceof ReauthError });
    });
  return true;
});

// ─── Storage helpers (serialized read-modify-write) ──────────────
let storageQueue = Promise.resolve();
function withStorageLock(fn) {
  const run = storageQueue.then(fn, fn);
  storageQueue = run.catch(() => {});
  return run;
}

function updateLocal(keys, fn) {
  return withStorageLock(async () => {
    const data = await chrome.storage.local.get(keys);
    const changes = await fn(data);
    if (changes) await chrome.storage.local.set(changes);
    return changes;
  });
}

async function getAccountById(accountId) {
  const { accounts = [] } = await chrome.storage.local.get('accounts');
  const acc = accounts.find(a => a.id === accountId);
  if (!acc) throw new Error('Account not found');
  return acc;
}

function patchAccount(accountId, patch) {
  return updateLocal(['accounts'], ({ accounts = [] }) => {
    const idx = accounts.findIndex(a => a.id === accountId);
    if (idx < 0) return null;
    accounts[idx] = { ...accounts[idx], ...patch };
    return { accounts };
  });
}

// Tokens live in session storage: not readable by content scripts, cleared on browser restart.
async function getTokenEntry(accountId) {
  const { tokens = {} } = await chrome.storage.session.get('tokens');
  return tokens[accountId];
}

function setTokenEntry(accountId, entry) {
  return withStorageLock(async () => {
    const { tokens = {} } = await chrome.storage.session.get('tokens');
    if (entry) tokens[accountId] = entry;
    else delete tokens[accountId];
    await chrome.storage.session.set({ tokens });
  });
}

// ─── OAuth ───────────────────────────────────────────────────────
async function hasWebClient() {
  return isClientId(await getClientId());
}

function checkGrantedScopes(scope, interactive) {
  // Only judge when Google tells us what was granted
  if (!scope || scope.split(' ').includes(GMAIL_SCOPE)) return;
  if (!interactive) throw new ReauthError('Gmail permission missing');
  throw new Error(MISSING_SCOPE_HELP);
}

// abortOnLoadForNonInteractive / timeoutMsAfterPageLoad give Google's silent page time to
// redirect, but only newer Chromium builds accept them — fall back when they're rejected.
let supportsSilentTimeout = true;

async function launchAuthFlow(url, interactive) {
  if (!interactive && supportsSilentTimeout) {
    try {
      return await chrome.identity.launchWebAuthFlow({
        url, interactive, abortOnLoadForNonInteractive: false, timeoutMsAfterPageLoad: 15000
      });
    } catch (err) {
      if (!/Unexpected property/i.test(err.message)) throw err;
      supportsSilentTimeout = false;
    }
  }
  return chrome.identity.launchWebAuthFlow({ url, interactive });
}

async function webAuth({ interactive, loginHint }) {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: await getClientId(),
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: SCOPES.join(' '),
    include_granted_scopes: 'true',
    state
  });
  if (loginHint) params.set('login_hint', loginHint);
  // Always show the consent screen when adding: Google lets users untick the Gmail
  // permission, and a silent re-grant would keep the token without Gmail access.
  params.set('prompt', interactive ? 'select_account consent' : 'none');

  let redirect;
  try {
    redirect = await launchAuthFlow(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, interactive);
  } catch (err) {
    if (interactive) throw err;
    // Network hiccups are temporary — the next sync retries. Anything else means Google
    // wanted user interaction (signed out, consent, security check).
    if (/could not be loaded|network|timed out/i.test(err.message)) {
      throw new Error(`Session renewal failed temporarily: ${err.message}`);
    }
    throw new ReauthError(err.message);
  }

  const result = new URLSearchParams(new URL(redirect).hash.slice(1));
  const error = result.get('error');
  if (error) {
    if (!interactive) throw new ReauthError(error);
    throw new Error(error === 'access_denied' ? 'Access denied by the user' : error);
  }
  if (result.get('state') !== state || !result.get('access_token')) throw new Error('Invalid OAuth response');
  checkGrantedScopes(result.get('scope'), interactive);
  return {
    token: result.get('access_token'),
    expiresAt: Date.now() + (Number(result.get('expires_in')) || 3600) * 1000
  };
}

async function fetchProfile(token) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Could not load the profile (HTTP ${res.status})`);
  const profile = await res.json();
  if (!profile.email) throw new Error('Could not load profile data');
  return profile;
}

const refreshing = new Map();

async function getAccessToken(account, { force = false } = {}) {
  const entry = await getTokenEntry(account.id);
  // Renew 5 min early so a slow silent refresh never leaves a request without a token
  if (!force && entry && entry.expiresAt - 5 * 60_000 > Date.now()) return entry.token;

  if (!refreshing.has(account.id)) {
    refreshing.set(account.id, (async () => {
      try {
        if (!(await hasWebClient())) throw new Error(CONFIG_HELP);
        const fresh = await webAuth({ interactive: false, loginHint: account.email });
        // Silent flows may hand back a different Google account — never mix mailboxes.
        const profile = await fetchProfile(fresh.token);
        if (profile.email.toLowerCase() !== account.email.toLowerCase()) {
          throw new ReauthError(`The active Google session is not ${account.email}`);
        }
        await setTokenEntry(account.id, fresh);
        if (account.needsReauth) await patchAccount(account.id, { needsReauth: false });
        return fresh.token;
      } catch (err) {
        if (err instanceof ReauthError) {
          console.warn(`[Unified Inbox] Token refresh failed for ${account.email}:`, err.message);
          await patchAccount(account.id, { needsReauth: true });
          throw new ReauthError(`Session expired for ${account.email}. Please sign in again.`);
        }
        throw err;
      } finally {
        refreshing.delete(account.id);
      }
    })());
  }
  return refreshing.get(account.id);
}

async function addAccount({ loginHint } = {}) {
  if (!(await hasWebClient())) throw new Error(CONFIG_HELP);
  const auth = await webAuth({ interactive: true, loginHint });
  const profile = await fetchProfile(auth.token);

  let account;
  await updateLocal(['accounts'], ({ accounts = [] }) => {
    const idx = accounts.findIndex(a => a.email.toLowerCase() === profile.email.toLowerCase());
    const prev = idx >= 0 ? accounts[idx] : null;
    const usedColors = new Set(accounts.map(a => a.color));
    const color = prev?.color || ACCOUNT_COLORS.find(c => !usedColors.has(c)) || ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length];
    account = {
      id: prev?.id || `acc_${profile.id || Date.now()}`,
      name: prev?.customName ? prev.name : (profile.name || profile.email.split('@')[0]),
      customName: prev?.customName || false,
      email: profile.email,
      initials: getInitials(prev?.customName ? prev.name : (profile.name || profile.email)),
      picture: profile.picture || '',
      color,
      needsReauth: false,
      inboxUnread: prev?.inboxUnread || 0,
      labels: prev?.labels || []
    };
    if (idx >= 0) accounts[idx] = account;
    else accounts.push(account);
    return { accounts };
  });

  await setTokenEntry(account.id, auth);
  try {
    await syncAccount(account);
  } catch (err) {
    console.warn('[Unified Inbox] Initial sync failed:', err);
    return { account, syncError: describeGmailError(err) };
  }
  return { account };
}

async function updateAccount(accountId, updates) {
  let updated = null;
  await updateLocal(['accounts'], ({ accounts = [] }) => {
    const acc = accounts.find(a => a.id === accountId);
    if (!acc) return null;
    const name = typeof updates.name === 'string' ? updates.name.trim() : '';
    if (name) {
      acc.name = name;
      acc.customName = true;
      acc.initials = getInitials(name);
    }
    if (/^#[0-9a-f]{6}$/i.test(updates.color || '')) acc.color = updates.color;
    if (Array.isArray(updates.countCategories)) {
      acc.countCategories = CATEGORIES.filter(c => updates.countCategories.includes(c));
      delete acc.tabs;
    }
    updated = acc;
    return { accounts };
  });
  if (!updated) throw new Error('Account not found');
  if (updates.countCategories) await syncAccount(updated);
  return updated;
}

async function removeAccount(accountId) {
  // Revoke Google's grant for this account, then forget everything stored for it
  const entry = await getTokenEntry(accountId);
  if (entry?.token) {
    // A simple form POST: no host permission needed, Google revokes it whether or not we read the reply
    fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: entry.token })
    }).catch(() => {});
  }
  await setTokenEntry(accountId, null);
  await updateLocal(['accounts', 'unifiedEmails'], ({ accounts = [], unifiedEmails = [] }) => ({
    accounts: accounts.filter(a => a.id !== accountId),
    unifiedEmails: unifiedEmails.filter(e => e.accountId !== accountId)
  }));
}

// ─── Gmail API client ────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Gmail allows each account 15,000 quota units per minute, and a conversation costs 10 units:
// loading a big inbox at full speed went over it ("403 Quota exceeded ... Units per minute per
// user"). Requests are paced per account with a token bucket: a burst of QUOTA_BURST units, then
// QUOTA_PER_MINUTE units a minute, so no minute ever goes past 13,000. Background work (sync, code
// detection) leaves a reserve so opening a conversation or archiving never waits behind it.
const QUOTA_PER_MINUTE = 10000;
const QUOTA_BURST = 3000;
const INTERACTIVE_RESERVE = 1000;
const quotaBuckets = new Map(); // accountId -> { units, at }

function quotaCost(method, path) {
  if (/\/messages\/send|\/drafts/.test(path)) return 100;
  if (/\/attachments\//.test(path)) return 5;
  if (/^\/(labels|settings|profile)/.test(path)) return 5;
  if (/^\/history/.test(path)) return 2;
  return 10; // threads list, get and modify; messages modify
}

function quotaBucket(accountId) {
  const now = Date.now();
  const bucket = quotaBuckets.get(accountId) || { units: QUOTA_BURST, at: now };
  bucket.units = Math.min(QUOTA_BURST, bucket.units + (now - bucket.at) * QUOTA_PER_MINUTE / 60000);
  bucket.at = now;
  quotaBuckets.set(accountId, bucket);
  return bucket;
}

async function takeQuota(accountId, cost, background) {
  const floor = background ? INTERACTIVE_RESERVE : 0;
  for (;;) {
    const bucket = quotaBucket(accountId);
    if (bucket.units - cost >= floor) { bucket.units -= cost; return; }
    await sleep(Math.min(5000, Math.ceil((floor + cost - bucket.units) * 60000 / QUOTA_PER_MINUTE)));
  }
}

const QUOTA_ERROR = /quota|rate ?limit|too many requests/i;
const QUOTA_HELP = 'Gmail is limiting requests for this account right now (too many in the last minute). Try again in a minute.';

async function gmail(account, path, { method = 'GET', body, raw, contentType, base = API, background = false } = {}) {
  let force = false;
  let quotaRetries = 0;
  for (let attempt = 0; ; attempt++) {
    await takeQuota(account.id, quotaCost(method, path), background);
    const token = await getAccessToken(account, { force });
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : raw ? { 'Content-Type': contentType } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : raw ? { body: raw } : {})
    });

    if (res.status === 401 && !force) { force = true; continue; }
    if (res.status >= 500 && attempt < 3) { await sleep(400 * 2 ** attempt); continue; }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error?.message || ''; } catch (e) {}
      // Over Gmail's per-minute quota: stop spending, wait and try again
      if (res.status === 429 || (res.status === 403 && QUOTA_ERROR.test(detail))) {
        quotaBuckets.set(account.id, { units: 0, at: Date.now() });
        if (quotaRetries < (background ? 5 : 3)) {
          const retryAfter = Number(res.headers.get('Retry-After')) * 1000;
          await sleep(retryAfter || Math.min(30000, 2000 * 2 ** quotaRetries++) + Math.random() * 1000);
          continue;
        }
        throw new Error(QUOTA_HELP);
      }
      if (res.status === 403 && /insufficient|scope/i.test(detail)) {
        await patchAccount(account.id, { needsReauth: true });
        throw new ReauthError(MISSING_SCOPE_HELP);
      }
      throw new Error(`Gmail HTTP ${res.status}${detail ? ` – ${detail}` : ''}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Sync ────────────────────────────────────────────────────────
let syncAllPromise = null;

function syncAll() {
  if (!syncAllPromise) {
    syncAllPromise = (async () => {
      const { accounts = [] } = await chrome.storage.local.get('accounts');
      const errors = [];
      await Promise.all(accounts.map(async (acc) => {
        try {
          await syncAccount(acc);
        } catch (err) {
          console.warn(`[Unified Inbox] Sync failed for ${acc.email}:`, err.message);
          errors.push(`${acc.email}: ${err.message}`);
        }
      }));
      await chrome.storage.local.set({ lastSync: Date.now() });
      return errors;
    })().finally(() => { syncAllPromise = null; });
  }
  return syncAllPromise;
}

// Which inbox categories are shown and counted — a per-account setting.
// Default mirrors Gmail with Promotions + Social tabs on (Updates/Forums land in Primary).
const CATEGORIES = ['primary', 'promotions', 'social', 'updates', 'forums'];
const OTHER_CATEGORIES = CATEGORIES.slice(1);
const DEFAULT_COUNTED = ['primary', 'updates', 'forums'];

function countedCategories(account) {
  if (Array.isArray(account.countCategories)) return account.countCategories.filter(c => CATEGORIES.includes(c));
  // v1.1 stored the Gmail tabs that were on; those are the categories left out
  if (Array.isArray(account.tabs)) return CATEGORIES.filter(c => c === 'primary' || !account.tabs.includes(c));
  return DEFAULT_COUNTED;
}

// Same categories drive what is listed and what is counted
function inboxQuery(account, extra = '') {
  const shown = countedCategories(account);
  if (!shown.length) return null;
  const base = shown.includes('primary')
    // Primary = no other category, so exclude only the categories left out
    ? ['in:inbox', ...OTHER_CATEGORIES.filter(c => !shown.includes(c)).map(c => `-category:${c}`)].join(' ')
    : `in:inbox {${shown.map(c => `category:${c}`).join(' ')}}`;
  return extra ? `${base} ${extra}` : base;
}

async function listThreadIds(account, q, limit, fields = 'threads/id,nextPageToken', { background = false } = {}) {
  const threads = [];
  let pageToken = '';
  while (threads.length < limit) {
    const res = await gmail(account, `/threads?q=${encodeURIComponent(q)}&maxResults=${Math.min(500, limit - threads.length)}` +
      `&fields=${fields}` + (pageToken ? `&pageToken=${pageToken}` : ''), { background });
    threads.push(...(res.threads || []));
    pageToken = res.nextPageToken;
    if (!pageToken) break;
  }
  threads.more = !!pageToken;
  return threads;
}

// Unread conversations in the categories the user chose to count
async function countInboxUnread(account) {
  const q = inboxQuery(account, 'is:unread');
  return q ? (await listThreadIds(account, q, 5000, undefined, { background: true })).length : 0;
}

// Only threads whose historyId changed need to be fetched again.
async function loadThreadSummary(account, t, prev, { background = false } = {}) {
  if (prev && prev.historyId === t.historyId && 'category' in prev && 'inInbox' in prev) return prev;
  try {
    const full = await gmail(account,
      `/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject` +
      '&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post&metadataHeaders=Content-Type', { background });
    return parseThread(full, account, t.snippet);
  } catch (err) {
    // One broken thread must not hide the rest
    console.warn(`[Unified Inbox] Could not load thread ${t.id} for ${account.email}:`, err.message);
    if (err instanceof ReauthError) throw err;
    return prev || null;
  }
}

// Gmail search (same operators as the Gmail search box) across every account
const SEARCH_LIMIT = 100;

// inView: only the given accounts, and only the inbox categories each one shows in the list
async function searchAll(query, { accountIds, inView } = {}) {
  const { accounts: all = [], unifiedEmails = [] } = await chrome.storage.local.get(['accounts', 'unifiedEmails']);
  const accounts = accountIds?.length ? all.filter(a => accountIds.includes(a.id)) : all;
  const cached = new Map(unifiedEmails.map(e => [e.key, e]));
  const errors = [];
  const perAccount = await Promise.all(accounts.map(async (acc) => {
    const scope = inView ? inboxQuery(acc) : '';
    if (inView && !scope) return []; // this account shows no categories
    try {
      const q = scope ? `${scope} (${query})` : query;
      const list = await listThreadIds(acc, q, SEARCH_LIMIT, 'threads(id,snippet,historyId),nextPageToken');
      return await mapLimit(list, FETCH_CONCURRENCY, (t) => loadThreadSummary(acc, t, cached.get(`${acc.id}:${t.id}`)));
    } catch (err) {
      errors.push(`${acc.email}: ${err.message}`);
      return [];
    }
  }));
  const results = perAccount.flat().filter(Boolean).sort((a, b) => b.internalDate - a.internalDate);
  return { results, errors };
}

async function syncAccount(account) {
  const [list, inboxUnread, labelsData] = await Promise.all([
    inboxQuery(account) ? listThreadIds(account, inboxQuery(account), account.inboxLimit || INBOX_LIMIT, 'threads(id,snippet,historyId),nextPageToken', { background: true }) : [],
    countInboxUnread(account),
    gmail(account, '/labels', { background: true })
  ]);

  const { unifiedEmails = [] } = await chrome.storage.local.get('unifiedEmails');
  const cached = new Map(unifiedEmails.filter(e => e.accountId === account.id).map(e => [e.id, e]));

  const threads = await mapLimit(list, FETCH_CONCURRENCY, (t) => loadThreadSummary(account, t, cached.get(t.id), { background: true }));

  console.info(`[Unified Inbox] ${account.email}: ` +
    `${list.length} conversations shown, ${threads.filter(Boolean).length} loaded, ${inboxUnread} unread (${countedCategories(account).join(', ') || 'nothing'})`);

  const labels = mapLabels(labelsData);
  const { bumps = {} } = await chrome.storage.local.get('bumps');

  await updateLocal(['accounts', 'unifiedEmails'], ({ accounts = [], unifiedEmails: current = [] }) => {
    const idx = accounts.findIndex(a => a.id === account.id);
    if (idx < 0) return null; // account removed meanwhile
    accounts[idx] = { ...accounts[idx], inboxUnread, labels, hasMore: !!list.more, lastSync: Date.now() };
    const merged = current.filter(e => e.accountId !== account.id).concat(threads.filter(Boolean));
    merged.forEach(e => { e.sortDate = Math.max(e.internalDate || 0, bumps[e.key] || 0); });
    merged.sort((a, b) => b.sortDate - a.sortDate);
    return { accounts, unifiedEmails: merged };
  });

  await notifyNewMail(account, threads.filter(Boolean));
}

function header(msg, name) {
  const h = (msg.payload?.headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function parseAddress(value) {
  if (!value) return { name: '', email: '' };
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim().toLowerCase() };
  return { name: value.trim(), email: value.trim().toLowerCase() };
}

function parseUnsubscribe(msg) {
  const raw = header(msg, 'List-Unsubscribe');
  if (!raw) return null;
  const links = [...raw.matchAll(/<([^>]+)>/g)].map(m => m[1].trim());
  const url = links.find(l => /^https:\/\//i.test(l)) || null;
  const mailto = links.find(l => /^mailto:/i.test(l)) || null;
  if (!url && !mailto) return null;
  const oneClick = /One-Click/i.test(header(msg, 'List-Unsubscribe-Post')) && !!url;
  return { url, mailto, oneClick };
}

function parseThread(thread, account, snippet) {
  const messages = (thread.messages || []).filter(m => !(m.labelIds || []).includes('TRASH'));
  if (!messages.length) return null;
  const last = messages[messages.length - 1];
  const inboxMessages = messages.filter(m => (m.labelIds || []).includes('INBOX'));
  const latestInbox = inboxMessages[inboxMessages.length - 1] || last;
  const allLabels = new Set(messages.flatMap(m => m.labelIds || []));

  const senders = [];
  for (const m of messages) {
    const from = parseAddress(header(m, 'From'));
    const isMe = from.email === account.email.toLowerCase();
    const unread = (m.labelIds || []).includes('UNREAD');
    const existing = senders.find(s => s.email === from.email);
    if (existing) {
      existing.unread = existing.unread || unread;
    } else {
      senders.push({ name: from.name, email: from.email, isMe, unread });
    }
  }

  const unsubscribe = messages.map(parseUnsubscribe).find(Boolean) || null;

  return {
    key: `${account.id}:${thread.id}`,
    id: thread.id,
    accountId: account.id,
    historyId: thread.historyId,
    lastMessageId: last.id,
    subject: header(messages[0], 'Subject') || '(no subject)',
    snippet: snippet ?? last.snippet ?? '',
    senders: senders.slice(-4),
    messageCount: messages.length,
    internalDate: Number(latestInbox.internalDate || last.internalDate || 0),
    unread: allLabels.has('UNREAD'),
    starred: allLabels.has('STARRED'),
    important: allLabels.has('IMPORTANT'),
    hasAttachment: messages.some(m => /multipart\/mixed/i.test(header(m, 'Content-Type'))),
    labelIds: [...allLabels].filter(l => l.startsWith('Label_')),
    inInbox: allLabels.has('INBOX'),
    category: ['PROMOTIONS', 'SOCIAL', 'UPDATES', 'FORUMS'].find(c => allLabels.has(`CATEGORY_${c}`))?.toLowerCase() || null,
    unsubscribe
  };
}

// ─── Thread actions ──────────────────────────────────────────────
const ACTIONS = {
  archive:   { remove: ['INBOX'], drop: true },
  unarchive: { add: ['INBOX'] },
  unspam:    { add: ['INBOX'], remove: ['SPAM'] },
  spam:      { add: ['SPAM'], remove: ['INBOX'], drop: true },
  read:      { remove: ['UNREAD'], patch: { unread: false } },
  unread:    { add: ['UNREAD'], patch: { unread: true } },
  unstar:    { remove: ['STARRED'], patch: { starred: false } },
  important: { add: ['IMPORTANT'], patch: { important: true } },
  unimportant: { remove: ['IMPORTANT'], patch: { important: false } }
};

async function applyThreadAction(account, threadId, action, labelId) {
  const base = `/threads/${threadId}`;
  if (action === 'trash') return gmail(account, `${base}/trash`, { method: 'POST' });
  if (action === 'untrash') {
    await gmail(account, `${base}/untrash`, { method: 'POST' });
    return gmail(account, `${base}/modify`, { method: 'POST', body: { addLabelIds: ['INBOX'] } });
  }
  if (action === 'star') {
    // Gmail stars the latest message of a conversation
    const { unifiedEmails = [] } = await chrome.storage.local.get('unifiedEmails');
    const cached = unifiedEmails.find(e => e.accountId === account.id && e.id === threadId);
    const msgId = cached?.lastMessageId;
    if (msgId) return gmail(account, `/messages/${msgId}/modify`, { method: 'POST', body: { addLabelIds: ['STARRED'] } });
    return gmail(account, `${base}/modify`, { method: 'POST', body: { addLabelIds: ['STARRED'] } });
  }
  if (action === 'move') {
    if (!labelId) throw new Error('Missing label');
    return gmail(account, `${base}/modify`, { method: 'POST', body: { addLabelIds: [labelId], removeLabelIds: ['INBOX'] } });
  }
  if (action === 'label') {
    return gmail(account, `${base}/modify`, { method: 'POST', body: { addLabelIds: [labelId] } });
  }
  if (action === 'unlabel') {
    return gmail(account, `${base}/modify`, { method: 'POST', body: { removeLabelIds: [labelId] } });
  }
  const def = ACTIONS[action];
  if (!def) throw new Error(`Unknown action: ${action}`);
  return gmail(account, `${base}/modify`, {
    method: 'POST',
    body: { addLabelIds: def.add || [], removeLabelIds: def.remove || [] }
  });
}

async function threadAction(items, action, labelId) {
  const { accounts = [] } = await chrome.storage.local.get('accounts');
  const done = [];
  const failed = [];

  await mapLimit(items, 5, async ({ accountId, threadId }) => {
    const key = `${accountId}:${threadId}`;
    const account = accounts.find(a => a.id === accountId);
    if (!account) { failed.push({ key, error: 'Account not found' }); return; }
    try {
      await applyThreadAction(account, threadId, action, labelId);
      done.push(key);
    } catch (err) {
      failed.push({ key, error: err.message });
    }
  });

  if (done.length) {
    const doneSet = new Set(done);
    const drop = action === 'trash' || action === 'move' || ACTIONS[action]?.drop;
    const patch = action === 'star' ? { starred: true } : ACTIONS[action]?.patch;
    await updateLocal(['unifiedEmails'], ({ unifiedEmails = [] }) => {
      let next = unifiedEmails;
      if (drop) next = next.filter(e => !doneSet.has(e.key));
      else if (patch) next = next.map(e => doneSet.has(e.key) ? { ...e, ...patch } : e);
      else if (action === 'label') next = next.map(e => doneSet.has(e.key) ? { ...e, labelIds: [...new Set([...(e.labelIds || []), labelId])] } : e);
      else if (action === 'unlabel') next = next.map(e => doneSet.has(e.key) ? { ...e, labelIds: (e.labelIds || []).filter(l => l !== labelId) } : e);
      return { unifiedEmails: next };
    });

    // Undo actions bring threads back — resync those accounts; otherwise just refresh unread counters.
    const touched = [...new Set(items.filter(i => doneSet.has(`${i.accountId}:${i.threadId}`)).map(i => i.accountId))];
    const restore = ['untrash', 'unarchive', 'unspam'].includes(action);
    await Promise.all(touched.map(async (accountId) => {
      const account = accounts.find(a => a.id === accountId);
      try {
        if (restore) await syncAccount(account);
        else {
          await patchAccount(accountId, { inboxUnread: await countInboxUnread(account) });
        }
      } catch (e) {}
    }));
  }

  if (!done.length && failed.length) {
    throw failed.some(f => /Session expired/.test(f.error))
      ? new ReauthError(failed[0].error)
      : new Error(failed[0].error);
  }
  return { done, failed };
}

// ─── Full thread (reader) ────────────────────────────────────────
async function getThread(accountId, threadId) {
  const account = await getAccountById(accountId);
  const thread = await gmail(account, `/threads/${threadId}?format=full`);
  const messages = (thread.messages || []).filter(m => !(m.labelIds || []).includes('TRASH'));

  return {
    id: thread.id,
    messages: await Promise.all(messages.map(async (m) => {
      const { html, text, attachments, inline } = extractParts(m.payload);
      return {
        id: m.id,
        from: parseAddress(header(m, 'From')),
        to: header(m, 'To'),
        cc: header(m, 'Cc'),
        replyTo: header(m, 'Reply-To'),
        messageId: header(m, 'Message-ID') || header(m, 'Message-Id'),
        references: header(m, 'References'),
        date: Number(m.internalDate || 0),
        subject: header(m, 'Subject'),
        snippet: m.snippet || '',
        unread: (m.labelIds || []).includes('UNREAD'),
        starred: (m.labelIds || []).includes('STARRED'),
        html: html ? await inlineCidImages(account, m.id, html, inline) : '',
        text,
        attachments
      };
    }))
  };
}

// Plain text of the latest message (used to find verification codes for list rows)
async function getThreadText(accountId, threadId) {
  const account = await getAccountById(accountId);
  // Only to show a code in the list: background priority
  const thread = await gmail(account, `/threads/${threadId}?format=full&fields=messages(labelIds,payload)`, { background: true });
  const messages = (thread.messages || []).filter(m => !(m.labelIds || []).includes('TRASH'));
  const { html, text } = extractParts(messages[messages.length - 1]?.payload);
  return (text || htmlToText(html)).slice(0, 8000);
}

function htmlToText(html) {
  return (html || '')
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ');
}

function extractParts(payload) {
  let html = '';
  let text = '';
  const attachments = [];
  const inline = [];

  (function walk(part) {
    if (!part) return;
    const headers = part.headers || [];
    const contentId = (headers.find(h => h.name.toLowerCase() === 'content-id')?.value || '').replace(/[<>]/g, '');
    const disposition = headers.find(h => h.name.toLowerCase() === 'content-disposition')?.value || '';

    if (part.filename && part.body?.attachmentId) {
      if (contentId && !/attachment/i.test(disposition)) {
        inline.push({ cid: contentId, attachmentId: part.body.attachmentId, mimeType: part.mimeType, size: part.body.size || 0 });
      } else {
        attachments.push({ filename: part.filename, mimeType: part.mimeType, size: part.body.size || 0, attachmentId: part.body.attachmentId });
      }
    } else if (part.mimeType === 'text/html' && part.body?.data && !html) {
      html = decodeBase64Url(part.body.data);
    } else if (part.mimeType === 'text/plain' && part.body?.data && !text) {
      text = decodeBase64Url(part.body.data);
    }
    (part.parts || []).forEach(walk);
  })(payload);

  return { html, text, attachments, inline };
}

async function inlineCidImages(account, messageId, html, inline) {
  const wanted = inline.filter(i => i.size < 1_500_000 && html.includes(`cid:${i.cid}`)).slice(0, 12);
  for (const img of wanted) {
    try {
      const data = await getAttachmentData(account, messageId, img.attachmentId);
      const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
      html = html.split(`cid:${img.cid}`).join(`data:${img.mimeType};base64,${b64}`);
    } catch (e) {}
  }
  return html;
}

async function getAttachmentData(account, messageId, attachmentId) {
  const res = await gmail(account, `/messages/${messageId}/attachments/${attachmentId}`);
  return res.data || '';
}

async function getAttachment(accountId, messageId, attachmentId) {
  const account = await getAccountById(accountId);
  return getAttachmentData(account, messageId, attachmentId);
}

// ─── Notifications ───────────────────────────────────────────────
async function accountIcon(account) {
  try {
    const canvas = new OffscreenCanvas(96, 96);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = account.color || '#0b57d0';
    ctx.beginPath();
    ctx.arc(48, 48, 48, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 38px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((account.initials || '?').slice(0, 2), 48, 51);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return `data:image/png;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
  } catch (e) {
    return chrome.runtime.getURL('assets/icons/icon128.png');
  }
}

async function notify(id, { title, message, contextMessage, account }) {
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: account ? await accountIcon(account) : chrome.runtime.getURL('assets/icons/icon128.png'),
      title,
      message: message || '',
      contextMessage: contextMessage || '',
      priority: 1
    });
  } catch (e) {
    console.warn('[Unified Inbox] Notification failed:', e.message);
  }
}

// New unread conversations since the last sync. The first sync of an account only sets the baseline.
async function notifyNewMail(account, threads) {
  const { accounts = [], prefs = {} } = await chrome.storage.local.get(['accounts', 'prefs']);
  const acc = accounts.find(a => a.id === account.id);
  if (!acc) return;
  const newest = threads.reduce((max, t) => Math.max(max, t.internalDate || 0), acc.notifiedUpTo || 0);
  const fresh = acc.notifiedUpTo ? threads.filter(t => t.unread && t.internalDate > acc.notifiedUpTo) : [];
  if (newest !== acc.notifiedUpTo) await patchAccount(acc.id, { notifiedUpTo: newest });
  if (!fresh.length || prefs.notifications === false) return;

  if (fresh.length > 3) {
    await notify(`account|${acc.id}|${Date.now()}`, {
      title: `${fresh.length} new emails`,
      message: fresh.slice(0, 3).map(t => t.subject).join('\n'),
      contextMessage: `${acc.name} · ${acc.email}`,
      account: acc
    });
    return;
  }
  for (const t of fresh) {
    const sender = t.senders?.find(s => !s.isMe) || t.senders?.[0];
    await notify(`thread|${t.key}`, {
      title: sender?.name || sender?.email || 'New email',
      message: `${t.subject}\n${htmlToText(t.snippet || '')}`.slice(0, 240),
      contextMessage: `${acc.name} · ${acc.email}`,
      account: acc
    });
  }
}

async function openInGmail(hash) {
  const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true, url: `${tabs[0].url.split('#')[0]}${hash}` });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: `https://mail.google.com/mail/u/0/${hash}` });
  }
}

// ─── Snooze and follow-up reminders ──────────────────────────────
// Each item lives in storage (so it survives restarts) and gets its own alarm; processDue()
// also runs on every sync to catch items whose alarm was lost while Chrome was closed.
const ITEM_KINDS = { snooze: 'snoozes', followup: 'followups' };
const SNOOZE_LABEL = 'Unified Inbox/Snoozed';

async function restoreItemAlarms() {
  const data = await chrome.storage.local.get(Object.values(ITEM_KINDS));
  for (const [kind, key] of Object.entries(ITEM_KINDS)) {
    for (const item of data[key] || []) {
      chrome.alarms.create(`${kind}:${item.id}`, { when: Math.max(Date.now() + 1000, item.dueAt) });
    }
  }
}

function addItem(kind, item) {
  const key = ITEM_KINDS[kind];
  return updateLocal([key], (data) => {
    const list = (data[key] || []).filter(x => x.id !== item.id);
    list.push(item);
    list.sort((a, b) => a.dueAt - b.dueAt);
    chrome.alarms.create(`${kind}:${item.id}`, { when: Math.max(Date.now() + 1000, item.dueAt) });
    return { [key]: list };
  });
}

function removeItem(kind, id) {
  const key = ITEM_KINDS[kind];
  chrome.alarms.clear(`${kind}:${id}`);
  return updateLocal([key], (data) => ({ [key]: (data[key] || []).filter(x => x.id !== id) }));
}

async function bump(key) {
  await updateLocal(['bumps'], ({ bumps = {} }) => {
    const monthAgo = Date.now() - 30 * 864e5;
    for (const k of Object.keys(bumps)) if (bumps[k] < monthAgo) delete bumps[k];
    bumps[key] = Date.now();
    return { bumps };
  });
}

let processing = false;
async function processDue() {
  if (processing) return;
  processing = true;
  try {
    const now = Date.now();
    const data = await chrome.storage.local.get(Object.values(ITEM_KINDS));
    const run = async (fn) => { try { await fn(); } catch (err) { console.warn('[Unified Inbox] Due item failed:', err.message); } };
    for (const item of (data.snoozes || []).filter(x => x.dueAt <= now)) await run(() => unsnooze(item.id, { notify: true }));
    for (const item of (data.followups || []).filter(x => x.dueAt <= now)) await run(() => checkFollowup(item));
  } finally {
    processing = false;
  }
}

async function cancelItem(kind, id) {
  if (kind === 'snooze') return unsnooze(id, { notify: false });
  return removeItem(kind, id);
}

// Snooze: Gmail's own snooze isn't in the API, so we park the thread under a label and bring it back
async function snoozeLabelId(account) {
  if (account.snoozeLabelId) return account.snoozeLabelId;
  const labels = await gmail(account, '/labels');
  let label = (labels.labels || []).find(l => l.name === SNOOZE_LABEL);
  if (!label) {
    label = await gmail(account, '/labels', {
      method: 'POST',
      body: { name: SNOOZE_LABEL, labelListVisibility: 'labelShow', messageListVisibility: 'hide' }
    });
  }
  await patchAccount(account.id, { snoozeLabelId: label.id });
  return label.id;
}

async function snooze(items, until) {
  if (!(until > Date.now())) throw new Error('Pick a time in the future');
  const { accounts = [], unifiedEmails = [] } = await chrome.storage.local.get(['accounts', 'unifiedEmails']);
  const done = [];
  const failed = [];
  for (const { accountId, threadId } of items) {
    const key = `${accountId}:${threadId}`;
    const account = accounts.find(a => a.id === accountId);
    try {
      if (!account) throw new Error('Account not found');
      const labelId = await snoozeLabelId(account);
      await gmail(account, `/threads/${threadId}/modify`, { method: 'POST', body: { addLabelIds: [labelId], removeLabelIds: ['INBOX'] } });
      const email = unifiedEmails.find(e => e.key === key);
      await addItem('snooze', { id: key, dueAt: Number(until), accountId, threadId, labelId, subject: email?.subject || '' });
      done.push(key);
    } catch (err) {
      failed.push({ key, error: err.message });
    }
  }
  if (done.length) {
    const doneSet = new Set(done);
    await updateLocal(['unifiedEmails'], ({ unifiedEmails: list = [] }) => ({ unifiedEmails: list.filter(e => !doneSet.has(e.key)) }));
  }
  if (!done.length && failed.length) throw new Error(failed[0].error);
  return { done, failed };
}

async function unsnooze(id, { notify: shouldNotify }) {
  const { snoozes = [], accounts = [] } = await chrome.storage.local.get(['snoozes', 'accounts']);
  const item = snoozes.find(x => x.id === id);
  if (!item) return;
  const account = accounts.find(a => a.id === item.accountId);
  if (!account) { await removeItem('snooze', id); return; }
  try {
    await gmail(account, `/threads/${item.threadId}/modify`, {
      method: 'POST',
      body: { addLabelIds: ['INBOX', 'UNREAD'], removeLabelIds: item.labelId ? [item.labelId] : [] }
    });
  } catch (err) {
    if (/HTTP 404/.test(err.message)) { await removeItem('snooze', id); return; } // thread deleted meanwhile
    throw err;
  }
  await removeItem('snooze', id);
  await bump(id);
  await syncAccount(account).catch(() => {});
  if (shouldNotify) {
    await notify(`thread|${id}`, { title: 'Snoozed email is back', message: item.subject, contextMessage: `${account.name} · ${account.email}`, account });
  }
}

// Follow-up: if nobody else has written in the thread by the due date, remind the user
async function setFollowup({ accountId, threadId, subject, days }) {
  const d = Number(days);
  if (!threadId || !(d > 0)) throw new Error('Invalid reminder');
  await getAccountById(accountId);
  const item = { id: `${accountId}:${threadId}`, dueAt: Date.now() + d * 864e5, createdAt: Date.now(), accountId, threadId, subject: subject || '', days: d };
  await addItem('followup', item);
  return { id: item.id, dueAt: item.dueAt };
}

async function checkFollowup(item) {
  const { accounts = [] } = await chrome.storage.local.get('accounts');
  const account = accounts.find(a => a.id === item.accountId);
  if (!account) { await removeItem('followup', item.id); return; }
  let thread;
  try {
    thread = await gmail(account, `/threads/${item.threadId}?format=metadata&metadataHeaders=From`, { background: true });
  } catch (err) {
    if (/HTTP 404/.test(err.message)) { await removeItem('followup', item.id); return; }
    throw err;
  }
  const me = account.email.toLowerCase();
  const replied = (thread.messages || []).some(m =>
    Number(m.internalDate) > item.createdAt && parseAddress(header(m, 'From')).email !== me);
  await removeItem('followup', item.id);
  if (replied) return;

  // Like Gmail's nudges: bring the conversation back to the top of the inbox
  await gmail(account, `/threads/${item.threadId}/modify`, { method: 'POST', body: { addLabelIds: ['INBOX'] } }).catch(() => {});
  await bump(item.id);
  await syncAccount(account).catch(() => {});
  await notify(`thread|${item.id}`, {
    title: `No reply after ${item.days} day${item.days === 1 ? '' : 's'}`,
    message: item.subject,
    contextMessage: `${account.name} · ${account.email}`,
    account
  });
}

// ─── Load more (beyond the first INBOX_LIMIT conversations) ──────
async function loadMore(accountIds) {
  const { accounts = [] } = await chrome.storage.local.get('accounts');
  const targets = accounts.filter(a => a.hasMore && (!accountIds?.length || accountIds.includes(a.id)));
  await Promise.all(targets.map(async (acc) => {
    const updated = { ...acc, inboxLimit: (acc.inboxLimit || INBOX_LIMIT) + LOAD_MORE_STEP };
    await patchAccount(acc.id, { inboxLimit: updated.inboxLimit });
    await syncAccount(updated);
  }));
  return { loaded: targets.length };
}

// ─── Labels ──────────────────────────────────────────────────────
// Gmail only accepts colours from its own palette
const LABEL_COLORS = {
  '#fb4c2f': '#ffffff', '#ffad47': '#ffffff', '#fad165': '#000000', '#16a766': '#ffffff',
  '#43d692': '#ffffff', '#4a86e8': '#ffffff', '#a479e2': '#ffffff', '#f691b3': '#ffffff',
  '#cccccc': '#000000', '#666666': '#ffffff', '#c9daf8': '#000000', '#b9e4d0': '#000000'
};

function mapLabels(labelsData) {
  return (labelsData.labels || [])
    .filter(l => l.type === 'user')
    .map(l => ({ id: l.id, name: l.name, color: l.color?.backgroundColor || null, textColor: l.color?.textColor || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function labelColor(color) {
  if (color === null) return { backgroundColor: null, textColor: null };
  return LABEL_COLORS[color] ? { backgroundColor: color, textColor: LABEL_COLORS[color] } : undefined;
}

async function refreshLabels(account) {
  await patchAccount(account.id, { labels: mapLabels(await gmail(account, '/labels')) });
}

async function labelCreate(accountId, name, color) {
  const account = await getAccountById(accountId);
  name = String(name || '').trim();
  if (!name) throw new Error('Label name is empty');
  const body = { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' };
  const c = labelColor(color);
  if (c?.backgroundColor) body.color = c;
  const label = await gmail(account, '/labels', { method: 'POST', body });
  await refreshLabels(account);
  return { id: label.id, name: label.name };
}

async function labelUpdate(accountId, labelId, name, color) {
  const account = await getAccountById(accountId);
  const body = {};
  if (typeof name === 'string' && name.trim()) body.name = name.trim();
  const c = color === undefined ? undefined : labelColor(color);
  if (c) body.color = c;
  if (!Object.keys(body).length) return;
  await gmail(account, `/labels/${labelId}`, { method: 'PATCH', body });
  await refreshLabels(account);
}

async function labelDelete(accountId, labelId) {
  const account = await getAccountById(accountId);
  await gmail(account, `/labels/${labelId}`, { method: 'DELETE' });
  await refreshLabels(account);
  await updateLocal(['unifiedEmails'], ({ unifiedEmails = [] }) => ({
    unifiedEmails: unifiedEmails.map(e => e.accountId === accountId && (e.labelIds || []).includes(labelId)
      ? { ...e, labelIds: e.labelIds.filter(l => l !== labelId) } : e)
  }));
}

// ─── Sending (compose / reply / forward) ─────────────────────────
const sendAsCache = new Map();

async function getSendAs(account) {
  if (!sendAsCache.has(account.id)) {
    const res = await gmail(account, '/settings/sendAs');
    const entry = (res.sendAs || []).find(x => x.isDefault) || (res.sendAs || []).find(x => x.isPrimary) || null;
    sendAsCache.set(account.id, entry && { email: entry.sendAsEmail, displayName: entry.displayName || '', signature: entry.signature || '' });
  }
  return sendAsCache.get(account.id);
}

const utf8 = (str) => new TextEncoder().encode(str);

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
const encodeWord = (v) => /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${bytesToBase64(utf8(v))}?=`;
// Display name for an address header: quoted when ASCII, RFC 2047 encoded-word (never quoted) otherwise
const displayName = (name) => /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, '')}"` : encodeWord(name);

// "Ana Silva <ana@x.pt>, bob@y.com" → RFC 5322 header value with encoded names
function formatAddresses(value) {
  // split on separators outside quotes / angle brackets ("Silva, João" <j@x.pt> stays whole)
  const parts = [];
  let current = '';
  let quoted = false;
  let angled = false;
  for (const ch of String(value || '')) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angled = true;
    else if (ch === '>' && !quoted) angled = false;
    if ((ch === ',' || ch === ';' || ch === '\n') && !quoted && !angled) { parts.push(current); current = ''; }
    else current += ch;
  }
  parts.push(current);
  return parts.map(x => x.trim()).filter(Boolean).map(part => {
    const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (!m) return part;
    return m[1] ? `${displayName(m[1])} <${m[2].trim()}>` : `<${m[2].trim()}>`;
  }).join(', ');
}

function buildMime({ from, to, cc, bcc, subject, html, text, inReplyTo, references, attachments }) {
  const id = crypto.randomUUID().replace(/-/g, '');
  const alt = `alt_${id}`;
  const mixed = `mix_${id}`;
  const headers = [
    `From: ${from}`,
    to && `To: ${formatAddresses(to)}`,
    cc && `Cc: ${formatAddresses(cc)}`,
    bcc && `Bcc: ${formatAddresses(bcc)}`,
    `Subject: ${encodeWord(subject || '')}`,
    inReplyTo && `In-Reply-To: ${inReplyTo}`,
    references && `References: ${references}`,
    'MIME-Version: 1.0'
  ].filter(Boolean);

  const altBody = [
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(bytesToBase64(utf8(text || ''))),
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(bytesToBase64(utf8(html || ''))),
    `--${alt}--`
  ].join('\r\n');

  if (!attachments.length) {
    return [...headers, `Content-Type: multipart/alternative; boundary="${alt}"`, '', altBody].join('\r\n');
  }

  const parts = attachments.map(a => {
    const name = a.filename || 'attachment';
    const ascii = /^[\x20-\x7e]*$/.test(name) && !/"/.test(name);
    const disp = ascii ? `filename="${name}"` : `filename*=UTF-8''${encodeURIComponent(name)}`;
    return [
      `--${mixed}`,
      `Content-Type: ${a.mimeType || 'application/octet-stream'}; ${ascii ? `name="${name}"` : `name="${encodeWord(name)}"`}`,
      `Content-Disposition: attachment; ${disp}`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(a.data.replace(/\s/g, ''))
    ].join('\r\n');
  });

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    altBody,
    ...parts,
    `--${mixed}--`
  ].join('\r\n');
}

// Builds the RFC 822 message and uploads it either as a sent message or as a Gmail draft
async function uploadMessage(kind, { accountId, to, cc, bcc, subject, html, text, threadId, inReplyTo, references, attachments = [], forwardAttachments = [] }) {
  const account = await getAccountById(accountId);
  if (kind === 'send' && ![to, cc, bcc].some(v => String(v || '').trim())) throw new Error('Add at least one recipient');

  const sendAs = await getSendAs(account).catch(() => null);
  const name = sendAs?.displayName || account.name || '';
  const from = name ? `${displayName(name)} <${account.email}>` : account.email;

  // Forwarded attachments are copied from the original message server-side
  const forwarded = await mapLimit(forwardAttachments, 3, async (a) => ({
    filename: a.filename,
    mimeType: a.mimeType,
    data: (await getAttachmentData(account, a.messageId, a.attachmentId)).replace(/-/g, '+').replace(/_/g, '/')
  }));

  const mime = buildMime({ from, to, cc, bcc, subject, html, text, inReplyTo, references, attachments: [...attachments, ...forwarded] });
  const metadata = kind === 'draft'
    ? { message: threadId ? { threadId } : {} }
    : (threadId ? { threadId } : {});
  const boundary = `upl_${crypto.randomUUID().replace(/-/g, '')}`;
  const raw = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: message/rfc822',
    '',
    mime,
    `--${boundary}--`
  ].join('\r\n');

  const res = await gmail(account, kind === 'draft' ? '/drafts?uploadType=multipart' : '/messages/send?uploadType=multipart', {
    method: 'POST',
    base: UPLOAD_API,
    raw,
    contentType: `multipart/related; boundary=${boundary}`
  });
  return { account, res };
}

async function sendMessage(payload) {
  const { account, res } = await uploadMessage('send', payload);
  syncAccount(account).catch(() => {});
  return { id: res.id, threadId: res.threadId };
}

// Saved in the account's Gmail Drafts; Gmail's own compose can then schedule it (the API can't)
async function createDraft(payload) {
  const { account, res } = await uploadMessage('draft', payload);
  return { draftId: res.id, messageId: res.message?.id, threadId: res.message?.threadId, email: account.email };
}

// ─── Unsubscribe (RFC 8058 one-click, else hand back the link) ───
async function unsubscribe(accountId, threadId) {
  const { unifiedEmails = [] } = await chrome.storage.local.get('unifiedEmails');
  const email = unifiedEmails.find(e => e.accountId === accountId && e.id === threadId);
  const info = email?.unsubscribe;
  if (!info) throw new Error('This message has no unsubscribe information');

  // The extension never contacts the sender itself (it only talks to Google): an unsubscribe
  // email is sent through the user's Gmail, otherwise the sender's page opens in a normal tab.
  if (info.mailto) return { method: 'mailto', mailto: info.mailto };
  return { method: 'url', url: info.url };
}

// ─── Helpers ─────────────────────────────────────────────────────
function describeGmailError(err) {
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(err.message)) {
    return 'The Gmail API is not enabled in the Google Cloud project. Enable it under APIs & Services → Library → Gmail API.';
  }
  return err.message;
}

function decodeBase64Url(data) {
  try {
    const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) {
    return '';
  }
}

function getInitials(name) {
  if (!name) return 'U';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return parts[0].substring(0, 2).toUpperCase();
}
