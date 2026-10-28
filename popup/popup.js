/* ================================================================
   UNIFIED INBOX — Popup Script
   ================================================================ */

'use strict';

let accounts = [];
let lastSync = 0;

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function relativeTime(ts) {
  if (!ts) return '';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ts).toLocaleDateString('en-GB');
}

function setStatus(text, isError = false) {
  const el = document.getElementById('status');
  el.textContent = text || '';
  el.classList.toggle('error', isError);
}

function render() {
  const list = document.getElementById('accounts-list');
  const totalEl = document.getElementById('total-unread');
  const total = accounts.reduce((s, a) => s + (a.inboxUnread || 0), 0);

  totalEl.hidden = total === 0;
  totalEl.textContent = `${total} unread`;
  document.getElementById('last-sync').textContent = relativeTime(lastSync);

  if (accounts.length === 0) {
    list.innerHTML = '<div class="empty">No accounts connected yet.<br>Add a Google account to get started.</div>';
    return;
  }

  list.innerHTML = accounts.map(a => `
    <button class="acc" data-id="${esc(a.id)}" title="Open ${esc(a.email)} in Unified Inbox">
      <span class="avatar" style="background:${esc(a.color)}">
        ${a.picture ? `<img src="${esc(a.picture)}" referrerpolicy="no-referrer" alt="" data-fallback="${esc(a.initials || '?')}">` : esc(a.initials || '?')}
      </span>
      <span class="info">
        <span class="name"><span class="dot" style="background:${esc(a.color)}"></span>${esc(a.name || a.email)}</span>
        <span class="email">${esc(a.email)}</span>
        ${a.needsReauth ? '<span class="warn">Session expired — click to sign in</span>' : ''}
      </span>
      ${a.inboxUnread ? `<span class="unread">${a.inboxUnread}</span>` : ''}
    </button>
  `).join('');

  list.querySelectorAll('img').forEach(img => {
    img.addEventListener('error', () => { img.replaceWith(document.createTextNode(img.dataset.fallback)); });
  });
}

function openUnified(path = '') {
  chrome.tabs.query({ url: 'https://mail.google.com/*' }, (tabs) => {
    if (tabs.length > 0) {
      // keep whichever Gmail account that tab is signed into (/mail/u/N/)
      const url = `${tabs[0].url.split('#')[0]}#allinboxes${path}`;
      chrome.tabs.update(tabs[0].id, { active: true, url });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url: `https://mail.google.com/mail/u/0/#allinboxes${path}` });
    }
    window.close();
  });
}

function sendMessage(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, (res) => {
      resolve(chrome.runtime.lastError ? { success: false, error: chrome.runtime.lastError.message } : res);
    });
  });
}

async function addAccount(loginHint) {
  setStatus('Opening Google sign-in…');
  const res = await sendMessage({ type: 'AUTH_ADD_ACCOUNT', ...(loginHint ? { loginHint } : {}) });
  if (res?.success && res.syncError) setStatus(`${res.account.email} connected, but: ${res.syncError}`, true);
  else if (res?.success) setStatus(`${res.account.email} connected.`);
  else setStatus(res?.error || "Couldn't complete sign-in.", true);
}

const CLIENT_ID_PATTERN = /^[\w-]+\.apps\.googleusercontent\.com$/;

// Sign-in uses the OAuth client of the user's own Google Cloud project (README, "Set up").
async function setupClient() {
  const setup = document.getElementById('setup');
  const input = document.getElementById('client-id-input');
  const { oauthClientId = '' } = await chrome.storage.local.get('oauthClientId');
  const redirectUri = chrome.identity.getRedirectURL();
  document.getElementById('redirect-uri').textContent = redirectUri;
  input.value = oauthClientId;
  setup.hidden = CLIENT_ID_PATTERN.test(oauthClientId);

  document.getElementById('copy-redirect-btn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(redirectUri);
    setStatus('Redirect URI copied.');
  });
  document.getElementById('save-client-btn').addEventListener('click', async () => {
    const value = input.value.trim();
    if (!CLIENT_ID_PATTERN.test(value)) {
      setStatus('That doesn\u2019t look like an OAuth client ID (…apps.googleusercontent.com).', true);
      return;
    }
    await chrome.storage.local.set({ oauthClientId: value });
    setup.hidden = true;
    setStatus('Saved. Now add your Google account.');
  });
  document.getElementById('client-settings-btn').addEventListener('click', () => {
    setup.hidden = !setup.hidden;
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  ({ accounts = [], lastSync = 0 } = await chrome.storage.local.get(['accounts', 'lastSync']));
  render();
  await setupClient();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.accounts) accounts = changes.accounts.newValue || [];
    if (changes.lastSync) lastSync = changes.lastSync.newValue || 0;
    if (changes.accounts || changes.lastSync) render();
  });

  document.getElementById('accounts-list').addEventListener('click', (e) => {
    const acc = accounts.find(a => a.id === e.target.closest('.acc')?.dataset.id);
    if (!acc) return;
    if (acc.needsReauth) addAccount(acc.email);
    else openUnified(`/${encodeURIComponent(acc.id)}`);
  });

  document.getElementById('open-gmail-btn').addEventListener('click', () => openUnified());
  document.getElementById('add-account-btn').addEventListener('click', () => addAccount());

  const syncBtn = document.getElementById('sync-btn');
  syncBtn.addEventListener('click', async () => {
    syncBtn.classList.add('spinning');
    setStatus('Syncing…');
    const res = await sendMessage({ type: 'SYNC_ALL_EMAILS' });
    syncBtn.classList.remove('spinning');
    if (res?.success) setStatus('Inboxes updated.');
    else setStatus(res?.error || 'Sync failed.', true);
  });
});
