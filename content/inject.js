/* ================================================================
   UNIFIED INBOX — Gmail Content Script
   - "All Inboxes" entry in Gmail's navigation
   - Account switcher in Gmail's header
   - Unified conversation list + reader rendered inside Gmail
   ================================================================ */
'use strict';

const PAGE_SIZE = 50;
const LOCALE = 'en-GB';
const FONT = '"Google Sans",Roboto,RobotoDraft,Helvetica,Arial,sans-serif';
const CATEGORIES = ['primary', 'promotions', 'social', 'updates', 'forums'];
const CATEGORY_NAMES = { primary: 'Primary', promotions: 'Promotions', social: 'Social', updates: 'Updates', forums: 'Forums' };
const DEFAULT_COUNTED = ['primary', 'updates', 'forums'];
function countedCategories(acc) {
  if (Array.isArray(acc.countCategories)) return acc.countCategories;
  if (Array.isArray(acc.tabs)) return CATEGORIES.filter(c => c === 'primary' || !acc.tabs.includes(c));
  return DEFAULT_COUNTED;
}

const AVAILABLE_COLORS = ['#1a73e8', '#188038', '#9334e6', '#e8710a', '#12a4af', '#d93025', '#e52592', '#f9ab00', '#3f51b5', '#5f6368'];

const state = {
  accounts: [],
  rawEmails: [],
  emails: [],
  lastSync: 0,
  multiAccount: true,
  redirectUrl: '',

  panelVisible: false,
  filter: 'all',
  page: 0,
  searchQuery: null,      // non-null while showing Gmail search results across accounts
  searchResults: [],
  searching: false,
  loadingMore: false,
  pendingCompose: null,   // reply mode to open once a thread finishes loading
  prefs: {},              // { notifications }
  items: { snoozes: [], followups: [] },
  selected: new Set(),
  focusIndex: -1,
  compact: false,
  sidebarCollapsed: false,
  defaultView: 'inbox',
  headerView: 'main',     // accounts menu page: 'main' | 'settings'
  sortMode: 'newest',     // 'newest' | 'oldest' | 'account' | 'account-rev'   // what Gmail shows when it opens: 'inbox' (Gmail's) or 'unified'
  headerMenuOpen: false,
  paletteFor: null,

  readingKey: null,
  thread: null,
  syncing: false
};

// Optimistic changes that the background has not confirmed yet: key → { drop } | { patch }
const pending = new Map();
const hosts = {};

// ══════════════════════════════════════════════════════════════════
//  0 · UTILITIES
// ══════════════════════════════════════════════════════════════════
const ICONS = {
  all_inbox: 'M18 4H6c-1.1 0-2 .9-2 2v3c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 5h-3.5c0 1.38-1.12 2.5-2.5 2.5S9.5 10.38 9.5 9H6V6h12v3zm-3 6h5v3c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2v-3h5c0 1.66 1.34 3 3 3s3-1.34 3-3z',
  label: 'M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z',
  archive: 'M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z',
  delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  spam: 'M15.73 3H8.27L3 8.27v7.46L8.27 21h7.46L21 15.73V8.27L15.73 3zM12 17.3c-.72 0-1.3-.58-1.3-1.3 0-.72.58-1.3 1.3-1.3.72 0 1.3.58 1.3 1.3 0 .72-.58 1.3-1.3 1.3zm1-4.3h-2V7h2v6z',
  mail: 'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z',
  drafts: 'M21.99 8c0-.72-.37-1.35-.94-1.7L12 1 2.95 6.3C2.38 6.65 2 7.28 2 8v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2l-.01-10zM12 13L3.74 7.84 12 3l8.26 4.84L12 13z',
  refresh: 'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  arrow_back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  chevron_left: 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  chevron_right: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  arrow_drop_down: 'M7 10l5 5 5-5z',
  arrow_right: 'M10 17l5-5-5-5v10z',
  star_border: 'M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z',
  star: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
  important: 'M3.5 18.99l11 .01c.67 0 1.27-.33 1.63-.84L20.5 12l-4.37-6.16c-.36-.51-.96-.84-1.63-.84l-11 .01L8.34 12 3.5 18.99z',
  important_border: 'M15 19H3l4.5-7L3 5h12c.65 0 1.26.31 1.63.84L21 12l-4.37 6.16c-.37.52-.98.84-1.63.84zm-8.5-2H15l3.5-5L15 7H6.5l3.5 5-3.5 5z',
  open_in_new: 'M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
  reply: 'M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z',
  forward: 'M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z',
  attach: 'M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z',
  download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  person_add: 'M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  palette: 'M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z',
  warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  minus: 'M19 13H5v-2h14v2z',
  density: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  more_vert: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  move_to: 'M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 12v-3h-4v-4h4V8l5 5-5 5z',
  arrow_up: 'M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z',
  arrow_down: 'M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z',
  picture_as_pdf: 'M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z',
  image: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z',
  description: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
  reply_all: 'M7 8V5l-7 7 7 7v-3l-4-4 4-4zm6 1V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z',
  format_bold: 'M15.6 10.79c.97-.67 1.65-1.77 1.65-2.79 0-2.26-1.75-4-4-4H7v14h7.04c2.09 0 3.71-1.7 3.71-3.79 0-1.52-.86-2.82-2.15-3.42zM10 6.5h3c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-3v-3zm3.5 9H10v-3h3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5z',
  format_italic: 'M10 4v3h2.21l-3.42 8H6v3h8v-3h-2.21l3.42-8H18V4z',
  format_underlined: 'M12 17c3.31 0 6-2.69 6-6V3h-2.5v8c0 1.93-1.57 3.5-3.5 3.5S8.5 12.93 8.5 11V3H6v8c0 3.31 2.69 6 6 6zm-7 2v2h14v-2H5z',
  format_list: 'M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z',
  link: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z',
  minimize: 'M6 19h12v2H6z',
  settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  cafe: 'M20 3H4v10c0 2.21 1.79 4 4 4h6c2.21 0 4-1.79 4-4v-3h2c1.11 0 2-.9 2-2V5c0-1.11-.89-2-2-2zm0 5h-2V5h2v3zM4 19h16v2H4z',
  sort: 'M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z',
  schedule: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
  bell: 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z',
  snippet: 'M14.17 5L19 9.83V19H5V5h9.17m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9.83c-.0-.53-.21-1.04-.59-1.41l-4.83-4.83c-.37-.38-.88-.59-1.41-.59zM7 15h10v2H7v-2zm0-4h10v2H7v-2zm0-4h7v2H7V7z',
  send_later: 'M2.01 21L23 12 2.01 3 2 10l15 2-15 2z',
  drag: 'M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  content_copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
  print: 'M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z'
};

function icon(name, size = 20) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
}

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Gmail snippets arrive HTML-encoded (&#39;, &amp;, …)
const entityCache = new Map();
function decodeEntities(str) {
  if (!str || !str.includes('&')) return str || '';
  if (!entityCache.has(str)) {
    entityCache.set(str, new DOMParser().parseFromString(`<!doctype html><body>${str}`, 'text/html').body.textContent);
  }
  return entityCache.get(str);
}

function normalize(str) {
  return (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function softColor(hex, alpha) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return `rgba(26,115,232,${alpha})`;
  return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${alpha})`;
}

function colorFor(seed) {
  let h = 0;
  for (const ch of seed || '') h = (h * 31 + ch.charCodeAt(0)) | 0;
  return AVAILABLE_COLORS[Math.abs(h) % AVAILABLE_COLORS.length];
}

function listDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
  }
  return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function relativeTime(ts) {
  const diff = (ts - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, secs] of units) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return rtf.format(0, 'minute');
}

function fullDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} (${relativeTime(ts)})`;
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function firstName(name) {
  return (name || '').split(/[\s@]/)[0] || name;
}

function getAccount(id) {
  return state.accounts.find(a => a.id === id);
}

function accountOf(email) {
  return getAccount(email.accountId) || { id: email.accountId, name: 'Account', email: '', color: '#5f6368' };
}

function gmailThreadUrl(acc, threadId) {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(acc.email)}#all/${threadId}`;
}

function avatarHtml(acc, size = 32) {
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;background:${acc.color}`;
  if (acc.picture) {
    return `<span class="avatar" style="${style}"><img src="${esc(acc.picture)}" referrerpolicy="no-referrer" alt="" data-fallback="${esc(acc.initials || '?')}"></span>`;
  }
  return `<span class="avatar" style="${style}">${esc(acc.initials || (acc.name || '?').charAt(0).toUpperCase())}</span>`;
}

function personAvatar(name, email, size = 40) {
  const letter = (name || email || '?').trim().charAt(0).toUpperCase();
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px;background:${colorFor(email || name)}">${esc(letter)}</span>`;
}

// Image fallback (inline onerror handlers are blocked by Gmail's CSP)
function installImageFallback(root) {
  root.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.dataset.fallback !== undefined) {
      img.replaceWith(document.createTextNode(img.dataset.fallback));
    }
  }, true);
}

function isolateEvents(host) {
  ['click', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'dragstart', 'dragover', 'drop', 'dragend', 'keydown', 'keypress', 'keyup'].forEach(type =>
    host.addEventListener(type, e => e.stopPropagation()));
}

function send(message) {
  return new Promise((resolve) => {
    if (!extensionAlive()) {
      resolve({ success: false, error: 'The extension was updated. Please reload Gmail.' });
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (res) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ success: false, error: err.message });
        else resolve(res || { success: false, error: 'No response from the extension service.' });
      });
    } catch (err) {
      resolve({
        success: false,
        error: /context invalidated/i.test(err.message)
          ? 'The extension was updated. Please reload Gmail.'
          : err.message
      });
    }
  });
}

function isTyping(e) {
  const el = e.composedPath()[0];
  return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

// ══════════════════════════════════════════════════════════════════
//  1 · DATA
// ══════════════════════════════════════════════════════════════════
function applyStored(data) {
  if ('accounts' in data) state.accounts = data.accounts || [];
  if ('unifiedEmails' in data) state.rawEmails = data.unifiedEmails || [];
  if ('lastSync' in data) state.lastSync = data.lastSync || 0;
  if (state.filter !== 'all' && state.accounts.length && !getAccount(state.filter)) state.filter = 'all';
  rebuildEmails();
}

function rebuildEmails() {
  const ids = new Set(state.accounts.map(a => a.id));
  state.emails = state.rawEmails
    .filter(e => ids.has(e.accountId) && !pending.get(e.key)?.drop)
    .map(e => {
      const p = pending.get(e.key);
      return p?.patch ? { ...e, ...p.patch } : e;
    });
  const keys = new Set(currentPool().map(e => e.key));
  state.selected.forEach(k => { if (!keys.has(k)) state.selected.delete(k); });
}

// Search results get the same optimistic overlay as the inbox list
function searchView() {
  const ids = new Set(state.accounts.map(a => a.id));
  return state.searchResults
    .filter(e => ids.has(e.accountId) && !pending.get(e.key)?.drop)
    .map(e => {
      const p = pending.get(e.key);
      return p?.patch ? { ...e, ...p.patch } : e;
    });
}

function currentPool() {
  return state.searchQuery !== null ? searchView() : state.emails;
}

const SORT_MODES = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  account: 'By account',
  'account-rev': 'By account (reversed)'
};

const emailDate = (e) => e.sortDate || e.internalDate || 0;

function sortEmails(list) {
  const mode = state.sortMode;
  if (mode === 'newest') return list; // already newest-first from the background
  if (mode === 'oldest') return [...list].sort((a, b) => emailDate(a) - emailDate(b));
  // By account: accounts in their configured order (or reversed), newest first inside each
  const order = new Map(state.accounts.map((a, i) => [a.id, mode === 'account' ? i : -i]));
  return [...list].sort((a, b) => (order.get(a.accountId) - order.get(b.accountId)) || (emailDate(b) - emailDate(a)));
}

function filteredEmails() {
  const pool = currentPool();
  return sortEmails(state.filter === 'all' ? pool : pool.filter(e => e.accountId === state.filter));
}

function pageEmails() {
  const all = filteredEmails();
  const maxPage = Math.max(0, Math.ceil(all.length / PAGE_SIZE) - 1);
  if (state.page > maxPage) state.page = maxPage;
  return { all, items: all.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE) };
}

function totalUnread() {
  return state.accounts.reduce((sum, a) => sum + (a.inboxUnread || 0), 0);
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderSidebar();
    renderHeader();
    if (labelManagerFor) renderLabelManager();
    if (state.panelVisible) {
      if (state.readingKey) renderReaderChrome();
      else renderList();
    }
  });
}

async function syncNow({ quiet = false } = {}) {
  if (state.syncing) return;
  state.syncing = true;
  hosts.view?.getElementById('btn-refresh')?.classList.add('spinning');
  renderHeader();
  const res = await send({ type: 'SYNC_ALL_EMAILS' });
  state.syncing = false;
  hosts.view?.getElementById('btn-refresh')?.classList.remove('spinning');
  renderHeader();
  if (!res.success) toast(`Sync failed: ${res.error}`);
  else if (!quiet) toast('Inboxes updated.');
}

// ══════════════════════════════════════════════════════════════════
//  2 · BOOT & ROUTING
// ══════════════════════════════════════════════════════════════════
function waitForGmail(cb) {
  const check = () => {
    if (document.querySelector('[role="navigation"]') && document.querySelector('[role="main"]')) cb();
    else setTimeout(check, 300);
  };
  check();
}

waitForGmail(init);

// After the extension is reloaded, scripts already running in open Gmail tabs lose their
// connection to it (chrome.storage disappears) until the page is reloaded.
function extensionAlive() {
  return !!(globalThis.chrome && chrome.runtime?.id && chrome.storage?.local);
}

// When the extension is reloaded/updated, this copy of the script stops receiving data.
// Instead of silently showing stale numbers, remove the old UI and ask for a reload.
function watchExtensionUpdates() {
  const timer = setInterval(() => {
    if (extensionAlive()) return;
    clearInterval(timer);
    hosts.sidebarHost?.remove();
    hosts.headerHost?.remove();
    hosts.sidebar = hosts.header = null;
    const bar = document.createElement('div');
    bar.style.cssText = `position:fixed;left:24px;bottom:24px;z-index:2147483000;display:flex;align-items:center;gap:12px;padding:10px 10px 10px 16px;border-radius:8px;background:#303030;color:#f2f2f2;font:14px ${FONT};box-shadow:0 4px 12px rgba(0,0,0,.3)`;
    bar.textContent = 'Unified Inbox was updated. Reload Gmail to keep using it.';
    const btn = document.createElement('button');
    btn.textContent = 'Reload';
    btn.style.cssText = 'border:0;background:none;color:#a8c7fa;font:500 14px inherit;cursor:pointer;padding:6px 10px;border-radius:4px';
    btn.onclick = () => location.reload();
    bar.appendChild(btn);
    document.body.appendChild(bar);
  }, 3000);
}

async function init() {
  if (hosts.sidebar || !extensionAlive()) return;

  const [data, config] = await Promise.all([
    chrome.storage.local.get(['accounts', 'unifiedEmails', 'lastSync', 'uiPrefs', 'prefs', 'snoozes', 'followups']),
    send({ type: 'GET_CONFIG' })
  ]);
  applyStored(data);
  applyItems(data);
  state.compact = !!data.uiPrefs?.compact;
  state.sidebarCollapsed = !!data.uiPrefs?.sidebarCollapsed;
  state.defaultView = data.uiPrefs?.defaultView === 'unified' ? 'unified' : 'inbox';
  state.sortMode = SORT_MODES[data.uiPrefs?.sortMode] ? data.uiPrefs.sortMode : 'newest';
  if (config.success) {
    state.multiAccount = config.multiAccount;
    state.redirectUrl = config.redirectUrl;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const data = {};
    for (const k of ['accounts', 'unifiedEmails', 'lastSync']) {
      if (changes[k]) data[k] = changes[k].newValue;
    }
    if (Object.keys(data).length) {
      applyStored(data);
      scheduleRender();
    }
    const items = {};
    for (const k of ['prefs', 'snoozes', 'followups']) {
      if (changes[k]) items[k] = changes[k].newValue;
    }
    if (Object.keys(items).length) {
      applyItems(items);
      renderHeader();
      if (plannerOpen) renderPlanner();
    }
  });

  ensureInjected();
  window.addEventListener('hashchange', applyRoute);
  watchExtensionUpdates();
  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mousedown', onDocumentMouseDown, true);
  document.addEventListener('click', onGmailSearchClick, true);
  // When an account needs to sign in again, Gmail opens in its own Inbox: All Inboxes
  // would be missing that account's mail
  const signInNeeded = state.accounts.some(a => a.needsReauth);
  if (state.defaultView === 'unified' && isInboxLanding() && !signInNeeded) {
    bootRedirectUntil = Date.now() + 6000;
    ['mousedown', 'keydown'].forEach(t => document.addEventListener(t, () => { bootRedirectUntil = 0; }, { capture: true, once: true }));
    navigate('all', null);
  }
  applyRoute();

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; ensureInjected(); }, 120);
  }).observe(document.body, { childList: true, subtree: true });
}

function ensureInjected() {
  if (!extensionAlive()) return;
  injectSidebar();
  injectHeader();
  if (state.panelVisible) {
    mountView();
    setNativeViewsVisible(false);
    clearNativeNavHighlight();
    setSearchPlaceholder(true);
  }
}

// Gmail may re-assert #inbox while it finishes loading; keep redirecting until the user acts
let bootRedirectUntil = 0;

function isInboxLanding() {
  return !location.hash || location.hash === '#inbox';
}

function parseRoute() {
  const hash = decodeURIComponent(location.hash || '');
  if (!hash.startsWith('#allinboxes')) return null;
  const [, filter = 'all', key = ''] = hash.slice(1).split('/');
  return { filter: filter || 'all', key: key || null };
}

function navigate(filter = state.filter, key = null) {
  let hash = '#allinboxes';
  if (filter !== 'all' || key) hash += `/${encodeURIComponent(filter)}`;
  if (key) hash += `/${encodeURIComponent(key)}`;
  if (location.hash === hash) applyRoute();
  else location.hash = hash;
}

function applyRoute() {
  const route = parseRoute();
  if (!route) {
    // Picking one of Gmail's search suggestions navigates to #search/… — keep it unified
    if (state.panelVisible && location.hash.startsWith('#search/')) {
      const query = decodeURIComponent(location.hash.slice('#search/'.length).replace(/\+/g, ' '));
      navigate(state.filter, null);
      runSearch(query);
      return;
    }
    if (Date.now() < bootRedirectUntil && isInboxLanding()) {
      navigate('all', null);
      return;
    }
    if (state.panelVisible) hidePanel();
    return;
  }
  if (route.filter !== state.filter) {
    // In "Current view" search mode the scope follows the account tab
    if (state.searchQuery !== null && state.prefs.searchScope === 'view') setTimeout(() => runSearch(state.searchQuery), 0);
    state.filter = route.filter;
    state.page = 0;
    state.selected.clear();
    state.focusIndex = -1;
  }
  showPanel();
  if (route.key) openReader(route.key);
  else closeReader();
}

function showPanel() {
  const wasVisible = state.panelVisible;
  state.panelVisible = true;
  const host = mountView();
  host.style.setProperty('display', 'flex', 'important');
  setNativeViewsVisible(false);
  clearNativeNavHighlight();
  scheduleRender();
  if (!wasVisible && state.accounts.length && Date.now() - state.lastSync > 60_000) syncNow({ quiet: true });
}

function hidePanel() {
  state.panelVisible = false;
  state.readingKey = null;
  state.thread = null;
  hideMenu();
  if (hosts.viewHost) hosts.viewHost.style.setProperty('display', 'none', 'important');
  setNativeViewsVisible(true);
  setSearchPlaceholder(false);
  if (state.searchQuery !== null) clearSearch({ render: false });
  scheduleRender();
}

function setNativeViewsVisible(visible) {
  document.querySelectorAll('[role="main"]').forEach(el => {
    if (el === hosts.viewHost) return;
    if (visible) {
      if (el.hasAttribute('data-ui-hidden')) {
        el.removeAttribute('data-ui-hidden');
        el.style.removeProperty('display');
      }
    } else if (!el.hasAttribute('data-ui-hidden')) {
      el.setAttribute('data-ui-hidden', 'true');
      el.style.setProperty('display', 'none', 'important');
    }
  });
}

function clearNativeNavHighlight() {
  document.querySelectorAll('[role="navigation"] .nZ').forEach(el => el.classList.remove('nZ'));
}

// ══════════════════════════════════════════════════════════════════
//  3 · SIDEBAR ("Todas as caixas" + one entry per account)
// ══════════════════════════════════════════════════════════════════
const SIDEBAR_CSS = `
  *{box-sizing:border-box}
  [hidden]{display:none!important}
  svg{fill:currentColor;flex-shrink:0}
  .nav{font-family:${FONT};padding-bottom:4px}
  .item{
    display:flex;align-items:center;height:32px;padding:0 12px 0 0;margin-right:16px;
    border-radius:0 16px 16px 0;cursor:pointer;user-select:none;
    font-size:14px;color:#202124;letter-spacing:.2px;
  }
  .item:hover{background:rgba(32,33,36,.059)}
  .item.active{background:#d3e3fd;color:#001d35;font-weight:700}
  .item.bold{font-weight:700}
  .exp{width:26px;height:32px;display:flex;align-items:center;justify-content:center;color:#444746;transition:transform .15s}
  .exp.open{transform:rotate(90deg)}
  .ic{width:20px;display:flex;justify-content:center;margin-right:18px;color:#444746}
  .item.active .ic{color:#001d35}
  .lbl{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cnt{font-size:12px;margin-left:8px;font-weight:700;letter-spacing:.3px}
  .warn{color:#d93025;display:flex;margin-left:8px}
  .sub .item{padding-left:26px}
  .sub .ic{width:20px}
  .add{color:#444746}
  .add .lbl{font-size:13px}
  .mini .item{justify-content:center;padding:0;margin:0 auto;width:32px;border-radius:50%}
  .mini .exp,.mini .lbl,.mini .cnt,.mini .warn,.mini .sub{display:none}
  .mini .ic{margin:0}
  .drop-before{box-shadow:inset 0 2px 0 #0b57d0}
  .drop-after{box-shadow:inset 0 -2px 0 #0b57d0}
`;

function injectSidebar() {
  if (hosts.sidebarHost?.isConnected) return;

  const inboxLink =
    document.querySelector('[role="navigation"] a[href$="#inbox"]') ||
    document.querySelector('[data-tooltip="Caixa de entrada"], [data-tooltip="Inbox"]');
  const anchor = inboxLink?.closest('.aim') || inboxLink?.closest('[role="listitem"]') || inboxLink;
  if (!anchor) return;

  if (!hosts.sidebarHost) {
    const host = document.createElement('div');
    host.id = 'ui-sidebar-root';
    host.style.cssText = 'all:initial;display:block;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${SIDEBAR_CSS}</style><div class="nav" id="nav"></div>`;
    root.addEventListener('click', onSidebarClick);
    enableAccountReorder(root, '.sub .item[data-nav]', el => el.dataset.nav);
    isolateEvents(host);
    installImageFallback(root);
    new ResizeObserver(([entry]) => {
      root.getElementById('nav').classList.toggle('mini', entry.contentRect.width < 120);
    }).observe(host);
    hosts.sidebarHost = host;
    hosts.sidebar = root;
  }
  const gmailList = anchor.parentElement;
  (gmailList && gmailList.parentElement ? gmailList : anchor).insertAdjacentElement('beforebegin', hosts.sidebarHost);
  renderSidebar();
}

function renderSidebar() {
  const root = hosts.sidebar;
  if (!root) return;
  const total = totalUnread();
  const allActive = state.panelVisible && state.filter === 'all';

  root.getElementById('nav').innerHTML = `
    <div class="item main${allActive ? ' active' : ''}${total ? ' bold' : ''}" data-nav="all" title="All inboxes">
      <span class="exp${state.sidebarCollapsed ? '' : ' open'}" data-act="toggle-sub">${icon('arrow_right', 16)}</span>
      <span class="ic">${icon('all_inbox')}</span>
      <span class="lbl">All Inboxes</span>
      ${total ? `<span class="cnt">${total.toLocaleString(LOCALE)}</span>` : ''}
    </div>
    <div class="sub"${state.sidebarCollapsed ? ' hidden' : ''}>
      ${state.accounts.map(a => `
        <div class="item${state.panelVisible && state.filter === a.id ? ' active' : ''}${a.inboxUnread ? ' bold' : ''}" data-nav="${esc(a.id)}" title="${esc(a.email)} — drag to reorder" draggable="true">
          <span class="ic" style="color:${a.color}">${icon('label', 18)}</span>
          <span class="lbl">${esc(a.name || a.email)}</span>
          ${a.needsReauth
            ? `<span class="warn" title="Session expired — click to sign in">${icon('warning', 16)}</span>`
            : a.inboxUnread ? `<span class="cnt">${a.inboxUnread.toLocaleString(LOCALE)}</span>` : ''}
        </div>`).join('')}
      <div class="item add" data-act="add-account">
        <span class="ic">${icon('add', 18)}</span>
        <span class="lbl">Add account</span>
      </div>
    </div>`;
}

function onSidebarClick(e) {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'toggle-sub') {
    e.stopPropagation();
    state.sidebarCollapsed = !state.sidebarCollapsed;
    saveUiPrefs();
    renderSidebar();
    return;
  }
  if (act === 'add-account') {
    addAccount();
    return;
  }
  const nav = e.target.closest('[data-nav]')?.dataset.nav;
  if (!nav) return;
  const acc = getAccount(nav);
  if (acc?.needsReauth && e.target.closest('.warn')) {
    reauth(acc);
    return;
  }
  state.page = 0;
  if (state.searchQuery !== null) clearSearch({ render: false });
  navigate(nav, null);
}

// ─── Account order (drag in the sidebar or the accounts menu) ────
function enableAccountReorder(root, selector, getId) {
  let dragId = null;
  const clear = () => root.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));

  root.addEventListener('dragstart', (e) => {
    const el = e.target.closest?.(selector);
    if (!el) return;
    dragId = getId(el);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  root.addEventListener('dragover', (e) => {
    const el = dragId && e.target.closest?.(selector);
    if (!el) return;
    e.preventDefault();
    clear();
    if (getId(el) === dragId) return;
    const r = el.getBoundingClientRect();
    el.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
  });
  root.addEventListener('drop', (e) => {
    const el = dragId && e.target.closest?.(selector);
    if (!el) return;
    e.preventDefault();
    const target = getId(el);
    const after = el.classList.contains('drop-after');
    clear();
    if (target !== dragId) moveAccount(dragId, target, after);
    dragId = null;
  });
  root.addEventListener('dragend', () => { dragId = null; clear(); });
}

async function moveAccount(id, targetId, after) {
  const order = state.accounts.map(a => a.id).filter(x => x !== id);
  let idx = order.indexOf(targetId);
  if (idx < 0) return;
  if (after) idx++;
  order.splice(idx, 0, id);

  const byId = new Map(state.accounts.map(a => [a.id, a]));
  state.accounts = order.map(x => byId.get(x));
  scheduleRender();
  const res = await send({ type: 'REORDER_ACCOUNTS', order });
  if (!res.success) toast(`Couldn't reorder accounts: ${res.error}`);
}

function saveUiPrefs() {
  if (!extensionAlive()) return;
  chrome.storage.local.set({ uiPrefs: { compact: state.compact, sidebarCollapsed: state.sidebarCollapsed, defaultView: state.defaultView, sortMode: state.sortMode } });
}

// ══════════════════════════════════════════════════════════════════
//  4 · HEADER — account switcher (Google account menu style)
// ══════════════════════════════════════════════════════════════════
const HEADER_CSS = `
  *{box-sizing:border-box}
  [hidden]{display:none!important}
  svg{fill:currentColor;flex-shrink:0}
  button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
  .wrap{position:relative;font-family:${FONT}}
  .trigger{
    height:40px;min-width:40px;padding:0 8px;border-radius:20px;display:flex;align-items:center;gap:6px;
    color:#444746;position:relative;
  }
  .trigger:hover{background:rgba(68,71,70,.08)}
  .trigger.open{background:rgba(68,71,70,.12)}
  .stack{display:flex;align-items:center}
  .stack .avatar{border:2px solid #f6f8fc;margin-left:-8px}
  .stack .avatar:first-child{margin-left:0}
  .t-count{font-size:12px;font-weight:700;color:#1f1f1f;padding-right:2px}
  .t-warn{position:absolute;top:4px;right:4px;width:10px;height:10px;border-radius:50%;background:#d93025;border:2px solid #f6f8fc}
  .avatar{border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:500;overflow:hidden;flex-shrink:0}
  .avatar img{width:100%;height:100%;object-fit:cover}

  .menu{
    position:absolute;top:calc(100% + 8px);right:0;width:400px;max-width:calc(100vw - 24px);
    background:#e9eef6;border-radius:28px;padding:8px 8px 12px;z-index:9999;
    box-shadow:0 4px 8px 3px rgba(60,64,67,.15),0 1px 3px rgba(60,64,67,.3);
    color:#1f1f1f;
  }
  .m-head{display:flex;align-items:center;gap:2px;min-height:52px;padding:0 4px 4px 16px;color:#1f1f1f}
  .m-head .m-icon:first-child{margin-left:-12px}
  .m-title{flex:1;min-width:0;font-size:14px;font-weight:500}
  .m-sub{font-size:12px;font-weight:400;color:#444746;margin-top:1px}
  .m-icon{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#444746;flex-shrink:0}
  .m-icon:hover{background:rgba(68,71,70,.08)}
  .m-icon.spinning svg{animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .row-btn .badge{margin-left:auto;min-width:22px;height:20px;padding:0 7px;border-radius:10px;background:#d3e3fd;color:#041e49;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center}
  .row-btn .chev{margin-left:auto;display:flex;color:#444746}
  .set-row{display:flex;align-items:center;gap:14px;padding:14px 16px 14px 20px}
  .set-row + .set-row{border-top:1px solid #e9eef6}
  .set-row .ic{width:24px;display:flex;justify-content:center;color:#444746;flex-shrink:0}
  .set-text{flex:1;min-width:0}
  .set-title{font-size:14px;color:#1f1f1f}
  .set-desc{font-size:12px;color:#444746;line-height:16px;margin-top:2px}
  .card{background:#fff;border-radius:20px;overflow:hidden;margin-top:4px}
  .card + .card{margin-top:4px}
  .acc-wrap{position:relative;padding:14px 12px 14px 20px}
  .acc-wrap + .acc-wrap{border-top:1px solid #e9eef6}
  .acc-wrap.drop-before{box-shadow:inset 0 2px 0 #0b57d0}
  .acc-wrap.drop-after{box-shadow:inset 0 -2px 0 #0b57d0}
  .acc{display:flex;align-items:center;gap:12px}
  .drag{position:absolute;left:2px;top:20px;width:18px;height:28px;display:flex;align-items:center;justify-content:center;color:#747775;cursor:grab;opacity:0;transition:opacity .12s}
  .acc-wrap:hover .drag{opacity:1}
  .acc-info{flex:1;min-width:0}
  .acc-name{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:500;color:#1f1f1f;min-width:0}
  .acc-name-t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .acc-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
  .acc-email{font-size:12px;color:#444746;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
  .acc-side{display:flex;align-items:center;gap:2px;flex-shrink:0}
  .acc-unread{min-width:22px;height:20px;padding:0 7px;border-radius:10px;background:#d3e3fd;color:#041e49;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;margin-right:2px}
  .acc-reauth{display:flex;align-items:center;gap:6px;margin:8px 0 0 52px;font-size:12px;color:#d93025}
  .acc-show{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:10px 0 0 52px}
  .show-lbl{font-size:12px;color:#444746;margin-right:2px}
  .tab-chip{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 10px;border-radius:8px;border:1px solid #c4c7c5;font-size:12px;font-weight:500;color:#444746}
  .tab-chip svg{width:14px;height:14px;margin-left:-2px}
  .tab-chip.on{background:#d3e3fd;border-color:#d3e3fd;color:#041e49}
  .tab-chip:hover{border-color:#747775}
  .ib{width:32px;height:32px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#444746}
  .ib:hover{background:rgba(68,71,70,.08)}
  .palette{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0 0 52px}
  .swatch{width:22px;height:22px;border-radius:50%;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(0,0,0,.1);display:flex;align-items:center;justify-content:center;color:#fff}
  .swatch:hover{transform:scale(1.12)}
  .row-btn{display:flex;align-items:center;gap:16px;width:100%;height:48px;padding:0 20px;font-size:14px;color:#1f1f1f;text-align:left}
  .row-btn:hover{background:#f1f3f4}
  .row-btn .ic{width:32px;display:flex;justify-content:center;color:#444746}
  .row-btn .sub{font-size:12px;color:#444746;margin-left:auto}
  .pill-btn{height:32px;padding:0 14px;border-radius:16px;font-size:13px;font-weight:500;color:#0b57d0;border:1px solid #747775}
  .pill-btn:hover{background:rgba(11,87,208,.08)}
  .seg{display:flex;border:1px solid #747775;border-radius:16px;overflow:hidden;flex-shrink:0}
  .seg-btn{height:30px;padding:0 12px;font-size:13px;font-weight:500;color:#444746}
  .seg-btn + .seg-btn{border-left:1px solid #747775}
  .seg-btn:hover{background:rgba(68,71,70,.08)}
  .seg-btn.on{background:#c2e7ff;color:#001d35}
  .m-foot{display:flex;align-items:center;justify-content:center;gap:8px;padding:8px 12px 0;font-size:12px;color:#444746}
  .m-foot a{color:#0b57d0;text-decoration:none;font-weight:500}
  .m-foot a:hover{text-decoration:underline}
  .m-foot .kofi{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:#FF5E5B;color:#fff}
  .m-foot .kofi:hover{background:#f04d4a;text-decoration:none}
  .note{font-size:12px;color:#444746;padding:10px 20px 2px;line-height:1.5}
  .empty{padding:20px;font-size:14px;color:#444746;text-align:center}
`;

function injectHeader() {
  if (hosts.headerHost?.isConnected) return;

  const settings = document.querySelector('[data-tooltip="Definições"], [data-tooltip="Settings"], a[aria-label*="Support"], [aria-label="Definições"], [aria-label="Settings"]');
  const settingsGroup = settings?.closest('.gb_v') || settings?.parentElement;
  const header = document.querySelector('header');
  if (!settingsGroup && !header) return;

  if (!hosts.headerHost) {
    const host = document.createElement('div');
    host.id = 'ui-header-pill-root';
    host.style.cssText = 'all:initial;display:inline-flex;align-items:center;position:relative;z-index:990;margin:0 4px;flex-shrink:0;align-self:center;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${HEADER_CSS}</style><div class="wrap" id="wrap"></div>`;
    root.addEventListener('click', onHeaderClick);
    enableAccountReorder(root, '.acc-wrap[data-id]', el => el.dataset.id);
    isolateEvents(host);
    installImageFallback(root);
    hosts.headerHost = host;
    hosts.header = root;
  }

  if (settingsGroup) settingsGroup.insertAdjacentElement('beforebegin', hosts.headerHost);
  else (document.querySelector('form[role="search"]')?.parentElement?.parentElement || header).appendChild(hosts.headerHost);
  renderHeader();
}

function renderHeader() {
  const root = hosts.header;
  if (!root) return;
  const accs = state.accounts;
  const needsReauth = accs.some(a => a.needsReauth);
  const total = totalUnread();

  const trigger = `
    <button class="trigger${state.headerMenuOpen ? ' open' : ''}" data-act="toggle-menu" title="Unified Inbox — connected accounts">
      ${accs.length
        ? `<span class="stack">${accs.slice(0, 3).map(a => avatarHtml(a, 26)).join('')}</span>`
        : icon('all_inbox', 22)}
      ${total ? `<span class="t-count">${total > 999 ? '999+' : total}</span>` : ''}
      ${needsReauth ? '<span class="t-warn"></span>' : ''}
    </button>`;

  const menu = !state.headerMenuOpen ? '' : `
    <div class="menu" role="dialog" aria-label="Connected accounts">
      ${state.headerView === 'settings' ? settingsPageHtml() : `
      <div class="m-head">
        <div class="m-title">
          <div>Unified Inbox · ${accs.length} ${accs.length === 1 ? 'account' : 'accounts'}</div>
          <div class="m-sub">${state.syncing ? 'Syncing…' : state.lastSync ? `Synced ${relativeTime(state.lastSync)}` : ''}</div>
        </div>
        <button class="m-icon${state.syncing ? ' spinning' : ''}" data-act="sync" title="Sync now">${icon('refresh')}</button>
        <button class="m-icon" data-act="close-menu" title="Close">${icon('close')}</button>
      </div>
      <div class="card">
        ${accs.length === 0 ? '<div class="empty">No Google accounts connected yet.</div>' : accs.map(a => `
          <div class="acc-wrap" data-id="${esc(a.id)}">
            <div class="acc">
              <span class="drag" draggable="true" title="Drag to reorder">${icon('drag', 18)}</span>
              ${avatarHtml(a, 40)}
              <div class="acc-info">
                <div class="acc-name"><span class="acc-dot" style="background:${a.color}"></span><span class="acc-name-t">${esc(a.name || a.email)}</span></div>
                <div class="acc-email" title="${esc(a.email)}">${esc(a.email)}</div>
              </div>
              <div class="acc-side">
                ${a.needsReauth
                  ? '<button class="pill-btn" data-act="reauth">Sign in</button>'
                  : a.inboxUnread ? `<span class="acc-unread" title="${a.inboxUnread} unread">${a.inboxUnread.toLocaleString(LOCALE)}</span>` : ''}
                <button class="ib" data-act="acc-more" title="Account options">${icon('more_vert')}</button>
              </div>
            </div>
            ${a.needsReauth ? `<div class="acc-reauth">${icon('warning', 14)} Session expired — sign in to keep this inbox updated</div>` : ''}
            <div class="acc-show" title="Which inbox categories are shown in the list and counted as unread">
              <span class="show-lbl">Show</span>
              ${CATEGORIES.map(c => `<button class="tab-chip${countedCategories(a).includes(c) ? ' on' : ''}" data-act="toggle-count" data-cat="${c}">${countedCategories(a).includes(c) ? icon('check', 14) : ''}${CATEGORY_NAMES[c]}</button>`).join('')}
            </div>
            ${state.paletteFor === a.id ? `
              <div class="palette">
                <span class="show-lbl">Colour</span>
                ${AVAILABLE_COLORS.map(c => `<span class="swatch" style="background:${c}" data-act="color" data-color="${c}" title="${c}">${c === a.color ? icon('check', 14) : ''}</span>`).join('')}
              </div>` : ''}
          </div>`).join('')}
      </div>
      <div class="card">
        <button class="row-btn" data-act="add-account"><span class="ic">${icon('person_add')}</span>Add another account</button>
        <button class="row-btn" data-act="planner"><span class="ic">${icon('schedule')}</span>Snoozed &amp; reminders${plannerCount() ? `<span class="badge">${plannerCount()}</span>` : ''}</button>
        <button class="row-btn" data-act="open-settings"><span class="ic">${icon('settings')}</span>Settings<span class="chev">${icon('chevron_right')}</span></button>
      </div>`}
      <div class="m-foot">
        <span>Made by <a href="https://github.com/MCCProgrammer" target="_blank" rel="noopener">mccprogrammer</a></span>
        <a class="kofi" href="https://ko-fi.com/mccprogrammer" target="_blank" rel="noopener" title="Support me on Ko-fi — Bug or feature idea? Leave a message with your donation and it gets priority." aria-label="Support me on Ko-fi">${icon('cafe', 16)}</a>
      </div>
      ${!state.multiAccount ? '<div class="note">Google sign-in isn\'t configured: set <b>WEB_CLIENT_ID</b> in <code>background/config.js</code>.</div>' : ''}
    </div>`;

  root.getElementById('wrap').innerHTML = trigger + menu;
}

function settingsPageHtml() {
  const seg = (act, attr, options, current) => `
    <div class="seg" role="radiogroup">
      ${options.map(([value, label]) => `<button class="seg-btn${current === value ? ' on' : ''}" data-act="${act}" data-${attr}="${value}" role="radio" aria-checked="${current === value}">${label}</button>`).join('')}
    </div>`;
  const row = (ic, title, desc, control) => `
    <div class="set-row">
      <span class="ic">${icon(ic)}</span>
      <div class="set-text"><div class="set-title">${title}</div><div class="set-desc">${desc}</div></div>
      ${control}
    </div>`;
  return `
    <div class="m-head">
      <button class="m-icon" data-act="settings-back" title="Back">${icon('arrow_back')}</button>
      <div class="m-title"><div>Settings</div></div>
      <button class="m-icon" data-act="close-menu" title="Close">${icon('close')}</button>
    </div>
    <div class="card">
      ${row('search', 'Search in', "What Gmail's search box looks through while All Inboxes is open",
        seg('search-scope', 'scope', [['all', 'All mail'], ['view', 'Current view']], state.prefs.searchScope === 'view' ? 'view' : 'all'))}
      ${row('bell', 'New mail notifications', 'Desktop alerts for new mail, even with Gmail closed (Chrome must be running)',
        seg('notif', 'on', [['1', 'On'], ['0', 'Off']], state.prefs.notifications === false ? '0' : '1'))}
      ${row('open_in_new', 'When Gmail opens', 'Start in All Inboxes or in the normal inbox',
        seg('default-view', 'view', [['unified', 'All Inboxes'], ['inbox', 'Inbox']], state.defaultView))}
    </div>`;
}

function setHeaderMenu(open) {
  state.headerMenuOpen = open;
  if (!open) state.headerView = 'main';
  if (!open) state.paletteFor = null;
  renderHeader();
}

function onHeaderClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  headerAction(btn.dataset.act, getAccount(btn.closest('[data-id]')?.dataset.id), btn);
}

async function headerAction(act, acc, btn) {
  switch (act) {
    case 'toggle-menu': setHeaderMenu(!state.headerMenuOpen); break;
    case 'close-menu': setHeaderMenu(false); break;
    case 'add-account': setHeaderMenu(false); addAccount(); break;
    case 'sync': syncNow(); break;
    case 'open-settings': state.headerView = 'settings'; renderHeader(); break;
    case 'settings-back': state.headerView = 'main'; renderHeader(); break;
    case 'open-all': setHeaderMenu(false); navigate('all', null); break;
    case 'planner': setHeaderMenu(false); openPlanner(); break;
    case 'search-scope': {
      const prefs = { ...state.prefs, searchScope: btn.dataset.scope === 'view' ? 'view' : 'all' };
      state.prefs = prefs;
      await chrome.storage.local.set({ prefs });
      setSearchPlaceholder(false);
      if (state.panelVisible) setSearchPlaceholder(true);
      if (state.searchQuery !== null) runSearch(state.searchQuery);
      toast(prefs.searchScope === 'view' ? 'Search looks only in the current view.' : 'Search looks in all mail of every account.');
      break;
    }
    case 'notif': {
      const prefs = { ...state.prefs, notifications: btn.dataset.on === '1' };
      await chrome.storage.local.set({ prefs });
      toast(prefs.notifications ? 'New mail notifications on.' : 'New mail notifications off.');
      break;
    }
    case 'default-view':
      state.defaultView = btn.dataset.view === 'unified' ? 'unified' : 'inbox';
      saveUiPrefs();
      renderHeader();
      toast(state.defaultView === 'unified' ? 'Gmail will open in All Inboxes.' : "Gmail will open in this account's Inbox.");
      break;
    case 'reauth': setHeaderMenu(false); reauth(acc); break;
    case 'labels': setHeaderMenu(false); openLabelManager(acc.id); break;
    case 'acc-more': {
      const ids = state.accounts.map(a => a.id);
      const idx = ids.indexOf(acc.id);
      const run = (a) => () => headerAction(a, acc);
      showMenu(btn, {
        items: [
          { label: 'Labels', icon: 'label', onClick: run('labels') },
          { label: 'Rename', icon: 'edit', onClick: run('rename') },
          { label: 'Change colour', icon: 'palette', onClick: run('palette') },
          ...(idx > 0 ? [{ label: 'Move up', icon: 'arrow_up', onClick: run('move-up') }] : []),
          ...(idx < ids.length - 1 ? [{ label: 'Move down', icon: 'arrow_down', onClick: run('move-down') }] : []),
          { sep: true },
          { label: 'Remove account', icon: 'delete', onClick: run('remove') }
        ]
      });
      break;
    }
    case 'move-up':
    case 'move-down': {
      const ids = state.accounts.map(a => a.id);
      const idx = ids.indexOf(acc.id);
      const neighbour = ids[act === 'move-up' ? idx - 1 : idx + 1];
      if (neighbour) moveAccount(acc.id, neighbour, act === 'move-down');
      break;
    }
    case 'toggle-count': {
      toast(`Updating ${acc.email}…`);
      const cat = btn.dataset.cat;
      const current = countedCategories(acc);
      const countCategories = current.includes(cat) ? current.filter(c => c !== cat) : [...current, cat];
      const res = await send({ type: 'UPDATE_ACCOUNT', accountId: acc.id, updates: { countCategories } });
      if (!res.success) toast(`Couldn't update: ${res.error}`);
      break;
    }
    case 'palette':
      state.paletteFor = state.paletteFor === acc.id ? null : acc.id;
      renderHeader();
      break;
    case 'color': {
      const res = await send({ type: 'UPDATE_ACCOUNT', accountId: acc.id, updates: { color: btn.dataset.color } });
      if (!res.success) toast(`Couldn't change the colour: ${res.error}`);
      break;
    }
    case 'rename': {
      setHeaderMenu(false);
      const name = await dialog({ title: 'Rename account', body: esc(acc.email), input: acc.name || '', confirm: 'Save' });
      if (name && name.trim()) {
        const res = await send({ type: 'UPDATE_ACCOUNT', accountId: acc.id, updates: { name } });
        toast(res.success ? 'Account renamed.' : `Couldn't rename: ${res.error}`);
      }
      break;
    }
    case 'remove': {
      setHeaderMenu(false);
      const ok = await dialog({
        title: 'Remove account?',
        body: `<b>${esc(acc.email)}</b> will no longer appear in Unified Inbox. No emails are deleted from Gmail.`,
        confirm: 'Remove'
      });
      if (!ok) return;
      const res = await send({ type: 'REMOVE_ACCOUNT', accountId: acc.id });
      if (!res.success) { toast(`Couldn't remove the account: ${res.error}`); return; }
      if (state.filter === acc.id) navigate('all', null);
      toast(`Account ${acc.email} removed.`);
      break;
    }
  }
}

// ══════════════════════════════════════════════════════════════════
//  5 · ACCOUNTS (add / re-authenticate)
// ══════════════════════════════════════════════════════════════════
async function addAccount() {
  if (!state.multiAccount) {
    await dialog({
      title: 'Setup required',
      body: `
        <p>Google sign-in isn't configured for this build of the extension.</p>
        <ol>
          <li>In Google Cloud Console → <b>APIs &amp; Services → Credentials</b>, create an <b>OAuth client ID</b> of type <b>Web application</b>.</li>
          <li>Under <b>Authorized redirect URIs</b> add:<br><code class="sel">${esc(state.redirectUrl)}</code></li>
          <li>Paste the Client ID into <code>background/config.js</code> (<code>WEB_CLIENT_ID</code>) and reload the extension.</li>
        </ol>`,
      confirm: 'OK',
      cancel: null
    });
    return;
  }

  toast('Opening Google sign-in…');
  const res = await send({ type: 'AUTH_ADD_ACCOUNT' });
  if (res.success && res.syncError) {
    await dialog({
      title: `${esc(res.account.email)} connected, but no emails`,
      body: `<p>Couldn't read the inbox:</p><p>${esc(res.syncError)}</p>`,
      confirm: 'OK',
      cancel: null
    });
    navigate('all', null);
    return;
  }
  if (res.success) {
    toast(`${res.account.email} connected.`);
    navigate('all', null);
    return;
  }
  if (/did not approve|cancel|closed/i.test(res.error || '')) {
    toast('Sign-in cancelled.');
    return;
  }
  await dialog({
    title: "Couldn't connect the account",
    body: `<p>${esc(res.error)}</p>${/redirect_uri|invalid_client|unauthorized_client/i.test(res.error || '')
      ? `<p>Check that the redirect URI <code class="sel">${esc(state.redirectUrl)}</code> is listed in the OAuth client in Google Cloud Console.</p>`
      : ''}`,
    confirm: 'OK',
    cancel: null
  });
}

async function reauth(acc) {
  if (!acc) return;
  toast(`Signing in to ${acc.email}…`);
  const res = await send({ type: 'AUTH_ADD_ACCOUNT', loginHint: acc.email });
  if (res.success && res.syncError) toast(`Signed in, but sync failed: ${res.syncError}`);
  else toast(res.success ? `Signed in to ${res.account.email}.` : `Couldn't sign in: ${res.error}`);
}

// ══════════════════════════════════════════════════════════════════
//  6 · UNIFIED VIEW (list + reader)
// ══════════════════════════════════════════════════════════════════
const COMPOSER_CSS = `
  .cmp{background:#fff;font-family:${FONT};font-size:14px;color:#1f1f1f;display:flex;flex-direction:column}
  .cmp input,.cmp select{font:inherit;color:inherit;border:0;outline:0;background:transparent;min-width:0}
  .cmp-row{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 16px;border-bottom:1px solid #f1f3f4}
  .cmp-row .lbl{color:#444746;flex-shrink:0;min-width:28px}
  .cmp-row input{flex:1;height:38px}
  .cmp-row select{flex:1;height:38px;cursor:pointer}
  .cc-link{color:#444746;font-size:13px;padding:4px 6px;border-radius:4px}
  .cc-link:hover{background:rgba(68,71,70,.08);color:#1f1f1f}
  .cmp-body{flex:1;min-height:120px;overflow-y:auto;padding:12px 16px;outline:0;font:14px/1.5 Arial,Helvetica,sans-serif;color:#222;word-break:break-word}
  .cmp-body:empty::before{content:attr(data-placeholder);color:#747775}
  .cmp-trim{margin:0 16px 8px;width:24px;height:12px;border-radius:6px;background:#e8eaed;color:#444746;font-size:11px;line-height:12px;text-align:center}
  .cmp-atts{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px}
  .cmp-atts:empty{display:none}
  .cmp-att{display:flex;align-items:center;gap:8px;height:32px;max-width:260px;padding:0 4px 0 10px;border-radius:8px;background:#f1f3f4;font-size:13px}
  .cmp-att .n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500;color:#0b57d0}
  .cmp-att .z{color:#444746;white-space:nowrap}
  .cmp-att .x{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#444746}
  .cmp-att .x:hover{background:rgba(68,71,70,.12)}
  .cmp-foot{display:flex;align-items:center;gap:2px;padding:10px 12px 12px 16px}
  .send-group{display:inline-flex;margin-right:8px}
  .btn-send{height:36px;padding:0 20px 0 24px;border-radius:18px 0 0 18px;background:#0b57d0;color:#fff;font-size:14px;font-weight:500}
  .btn-send-more{height:36px;width:32px;border-radius:0 18px 18px 0;background:#0b57d0;color:#fff;display:inline-flex;align-items:center;justify-content:center;border-left:1px solid rgba(255,255,255,.35)}
  .btn-send:hover,.btn-send-more:hover{background:#0a4fbf}
  .btn-send[disabled],.btn-send[disabled] + .btn-send-more{background:#c4c7c5;pointer-events:none}
  .cmp-remind{display:inline-flex;align-items:center;gap:2px;height:32px;padding:0 8px;border-radius:16px;color:#444746;font-size:12px;font-weight:500}
  .cmp-remind:hover{background:rgba(68,71,70,.08)}
  .cmp-remind.on{background:#d3e3fd;color:#041e49}
  .cmp .ib{width:32px;height:32px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#444746}
  .cmp .ib:hover{background:rgba(68,71,70,.08);color:#1f1f1f}
  .cmp .ib svg{width:20px;height:20px}
  .cmp .spacer{flex:1}
  .cmp .fsep{width:1px;height:20px;background:#c4c7c5;margin:0 4px}

  .cmp.inline{border-radius:16px;margin:8px 0 16px 56px;box-shadow:0 1px 2px 0 rgba(60,64,67,.3),0 2px 6px 2px rgba(60,64,67,.15)}
  .cmp.inline .cmp-row:first-child{border-radius:16px 16px 0 0}
  .cmp-mode{display:flex;color:#444746}

  .cmp.floating{position:fixed;right:16px;bottom:0;width:min(560px,calc(100vw - 32px));height:min(560px,calc(100vh - 80px));border-radius:16px 16px 0 0;overflow:hidden;
    box-shadow:0 8px 10px 1px rgba(0,0,0,.14),0 3px 14px 2px rgba(0,0,0,.12),0 5px 5px -3px rgba(0,0,0,.2)}
  .cmp.floating.min{height:40px;width:280px}
  .cmp.floating.min .cmp-main{display:none}
  .cmp-head{display:flex;align-items:center;gap:4px;height:40px;padding:0 8px 0 16px;background:#f2f6fc;color:#041e49;font-weight:500;cursor:pointer;flex-shrink:0}
  .cmp-head .t{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cmp-head .hb{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#444746}
  .cmp-head .hb:hover{background:rgba(68,71,70,.12)}
  .cmp-head .hb svg{width:18px;height:18px}
  .cmp-main{flex:1;min-height:0;display:flex;flex-direction:column}
  .cmp-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
`;

const VIEW_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  ${COMPOSER_CSS}
  [hidden]{display:none!important}
  svg{fill:currentColor;flex-shrink:0}
  button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
  :host{font-family:${FONT};font-size:14px;color:#1f1f1f}
  .view{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:#fff;font-family:${FONT};font-size:14px;color:#1f1f1f}

  /* ── Toolbar ── */
  .toolbar{display:flex;align-items:center;gap:2px;height:48px;padding:0 8px 0 12px;flex-shrink:0;user-select:none}
  .ib{width:40px;height:40px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#444746;flex-shrink:0;position:relative}
  .ib:hover{background:rgba(68,71,70,.08);color:#1f1f1f}
  .ib:active{background:rgba(68,71,70,.12)}
  .ib[disabled]{opacity:.38;pointer-events:none}
  .ib.sm{width:32px;height:32px}
  .sep{width:1px;height:20px;background:#c4c7c5;margin:0 6px;flex-shrink:0}
  .spacer{flex:1}
  .tb-group{display:flex;align-items:center;gap:2px}
  .compose-btn{display:flex;align-items:center;gap:10px;height:36px;padding:0 16px 0 12px;margin-left:8px;border-radius:12px;background:#c2e7ff;color:#001d35;font-size:14px;font-weight:500}
  .compose-btn:hover{box-shadow:0 1px 2px rgba(0,0,0,.3),0 1px 3px 1px rgba(0,0,0,.15)}
  .cb-wrap{display:flex;align-items:center;height:40px;border-radius:4px;padding:0 0 0 10px}
  .cb-wrap:hover{background:rgba(68,71,70,.08)}
  .cb{
    width:18px;height:18px;border-radius:2px;border:2px solid #444746;display:inline-flex;align-items:center;justify-content:center;
    color:#fff;cursor:pointer;flex-shrink:0;background:transparent;
  }
  .cb svg{display:none;width:16px;height:16px}
  .cb.checked,.cb.partial{background:#0b57d0;border-color:#0b57d0}
  .cb.checked .i-check,.cb.partial .i-minus{display:block}
  .caret{width:20px;height:40px;display:flex;align-items:center;justify-content:center;color:#444746;cursor:pointer}
  .spinning svg{animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}

  .search{display:flex;align-items:center;gap:4px;height:36px;width:min(300px,30vw);padding:0 4px 0 10px;border-radius:18px;background:#eaf1fb;color:#444746;margin-right:8px;transition:background .15s,box-shadow .15s}
  .search:focus-within{background:#fff;box-shadow:0 1px 1px 0 rgba(65,69,73,.3),0 1px 3px 1px rgba(65,69,73,.15)}
  .search input{flex:1;min-width:0;border:0;outline:0;background:transparent;font:inherit;font-size:14px;color:#1f1f1f}
  .search input::placeholder{color:#444746}
  .pager{display:flex;align-items:center;font-size:12px;color:#444746;white-space:nowrap;padding:0 4px}
  .pager span{padding:0 8px}

  /* ── Notices ── */
  .searchbar{display:flex;align-items:center;gap:12px;padding:8px 16px;background:#f6f8fc;color:#1f1f1f;font-size:14px;flex-shrink:0;border-bottom:1px solid rgba(100,121,143,.122)}
  .searchbar svg{color:#444746}
  .searchbar .spacer{flex:1}
  .searchbar button{color:#0b57d0;font-weight:500;padding:6px 12px;border-radius:16px}
  .searchbar button:hover{background:rgba(11,87,208,.08)}
  .notice{display:flex;align-items:center;gap:12px;padding:8px 16px;background:#fce8e6;color:#410e0b;font-size:13px;flex-shrink:0}
  .notice + .notice{border-top:1px solid #fff}
  .notice svg{color:#d93025}
  .notice .spacer{flex:1}
  .notice button{color:#0b57d0;font-weight:500;padding:6px 12px;border-radius:16px}
  .notice button:hover{background:rgba(11,87,208,.08)}

  /* ── Tabs (Gmail category style, one per account) ── */
  .tabs{display:flex;height:56px;flex-shrink:0;overflow-x:auto;scrollbar-width:none;border-bottom:1px solid rgba(100,121,143,.122)}
  .tabs::-webkit-scrollbar{display:none}
  .tab{
    flex:0 1 256px;min-width:140px;display:flex;align-items:center;gap:16px;padding:0 16px;position:relative;
    color:#444746;font-size:14px;font-weight:500;cursor:pointer;user-select:none;
  }
  .tab:hover{background:rgba(68,71,70,.08)}
  .tab .t-ic{display:flex;color:#444746}
  .tab .t-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .tab .t-total{font-size:12px;color:#444746;font-weight:400;white-space:nowrap;flex-shrink:0}
  .tab .t-new{font-size:12px;font-weight:500;color:#fff;border-radius:8px;padding:0 6px;line-height:16px;white-space:nowrap;flex-shrink:0}
  .tab.active{color:var(--c)}
  .tab.active .t-ic{color:var(--c)}
  .tab.active::after{content:"";position:absolute;left:8px;right:8px;bottom:0;height:3px;border-radius:3px 3px 0 0;background:var(--c)}

  /* ── Conversation list ── */
  .scroll{flex:1;overflow-y:auto;min-height:0}
  .scroll::-webkit-scrollbar{width:16px}
  .scroll::-webkit-scrollbar-thumb{background:#c4c7c5;border:4px solid #fff;border-radius:8px}
  .row{
    display:flex;align-items:center;height:40px;padding-right:16px;position:relative;cursor:pointer;
    box-shadow:inset 0 -1px 0 0 rgba(100,121,143,.122);background:rgba(242,245,245,.8);
  }
  :host(.compact) .row{height:32px}
  .row.unread{background:#fff}
  .row:hover{box-shadow:inset 1px 0 0 #dadce0,inset -1px 0 0 #dadce0,0 1px 2px 0 rgba(60,64,67,.3),0 1px 3px 1px rgba(60,64,67,.15);z-index:2}
  .row.selected{background:#c2dbfe}
  .row.focused::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:#0b57d0}
  .stripe{width:4px;height:20px;border-radius:2px;margin:0 6px 0 8px;flex-shrink:0}
  .c-cb{width:40px;height:40px;display:flex;align-items:center;justify-content:center;flex-shrink:0;border-radius:50%}
  .c-cb:hover{background:rgba(68,71,70,.08)}
  .c-star,.c-imp{width:32px;height:32px;display:flex;align-items:center;justify-content:center;color:#444746;flex-shrink:0;border-radius:50%;opacity:.7}
  .c-star:hover,.c-imp:hover{opacity:1;background:rgba(68,71,70,.08)}
  .c-star.on{color:#f4b400;opacity:1}
  .c-imp.on{color:#f4b400;opacity:1}
  .c-from{flex:0 0 232px;padding:0 16px 0 8px;display:flex;align-items:center;gap:8px;white-space:nowrap;overflow:hidden}
  .from-names{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
  .c-from .u{font-weight:700}
  .c-from .count{font-size:12px;color:#444746;font-weight:400;margin-left:2px}
  .row.unread .c-from,.row.unread .subj,.row.unread .c-date{font-weight:700;color:#1f1f1f}
  .c-main{flex:1;min-width:0;display:flex;align-items:center;gap:4px;overflow:hidden}
  .text{flex:1;min-width:0;display:flex;align-items:center;white-space:nowrap;overflow:hidden}
  .subj{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
  .snip{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;color:#444746}
  .chip{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;font-size:12px;font-weight:500;white-space:nowrap;flex-shrink:0;max-width:160px;overflow:hidden;text-overflow:ellipsis}
  .chip.lbl{background:#dde3ea;color:#444746}
  .unsub{display:none;height:24px;padding:0 10px;border-radius:12px;border:1px solid #747775;font-size:12px;font-weight:500;color:#444746;white-space:nowrap;flex-shrink:0;align-items:center;margin-left:8px}
  .unsub:hover{background:rgba(68,71,70,.08);color:#0b57d0}
  .row:hover .unsub{display:inline-flex}
  .c-att{display:flex;color:#444746;margin-left:8px;transform:rotate(45deg)}
  .c-date{flex:0 0 auto;min-width:64px;padding-left:16px;text-align:right;font-size:12px;color:#444746;white-space:nowrap}
  .c-actions{display:none;position:absolute;right:8px;top:0;bottom:0;align-items:center;gap:2px;padding-left:12px;background:inherit}
  .row:hover{padding-right:236px}
  .row:hover .c-actions{display:flex}
  .row:hover .c-date{display:none}
  .c-actions .ib{width:40px;height:40px}
  :host(.compact) .c-actions .ib{width:32px;height:32px}

  .empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:72px 24px;color:#444746;text-align:center}
  .empty svg{width:72px;height:72px;color:#c4c7c5}
  .empty h3{font-size:18px;font-weight:400;color:#1f1f1f}
  .empty p{font-size:14px;max-width:380px;line-height:20px}
  .btn-filled{height:40px;padding:0 24px;border-radius:20px;background:#0b57d0;color:#fff;font-size:14px;font-weight:500;display:inline-flex;align-items:center;gap:8px}
  .btn-filled:hover{box-shadow:0 1px 2px rgba(0,0,0,.3),0 1px 3px 1px rgba(0,0,0,.15);background:#0a4fbf}
  .group-head{display:flex;align-items:center;gap:8px;height:36px;padding:0 16px;background:#f6f8fc;font-size:13px;font-weight:600;color:#1f1f1f;box-shadow:inset 0 -1px 0 rgba(100,121,143,.122);position:sticky;top:0;z-index:3}
  .gh-dot{width:10px;height:10px;border-radius:50%;background:var(--c)}
  .gh-mail{font-weight:400;color:#444746}
  .gh-n{margin-left:auto;font-weight:500;color:#444746;font-size:12px}
  .sort-btn{display:flex;align-items:center;gap:6px;height:32px;padding:0 10px 0 8px;border-radius:16px;color:#444746;font-size:13px;font-weight:500;margin-right:4px}
  .sort-btn:hover{background:rgba(68,71,70,.08);color:#1f1f1f}
  .selbar{display:flex;align-items:center;justify-content:center;gap:8px;padding:8px 16px;background:#f2f6fc;font-size:14px;color:#1f1f1f;border-bottom:1px solid rgba(100,121,143,.122)}
  .selbar button{color:#0b57d0;font-weight:500;padding:4px 8px;border-radius:4px}
  .selbar button:hover{background:rgba(11,87,208,.08)}
  .load-more-wrap{display:flex;justify-content:center;padding:16px}
  .load-more{display:flex;align-items:center;gap:10px;height:36px;padding:0 20px;border-radius:18px;border:1px solid #747775;color:#0b57d0;font-weight:500}
  .load-more:hover{background:rgba(11,87,208,.08)}
  .load-more[disabled]{color:#444746;pointer-events:none}
  .load-more .ring{width:16px;height:16px;border:2px solid #d3e3fd;border-top-color:#0b57d0;border-radius:50%;animation:spin .8s linear infinite}
  .footer{padding:16px 24px 24px;font-size:12px;color:#444746;display:flex;justify-content:space-between}

  /* ── Reader (Gmail conversation view) ── */
  .r-wrap{padding:0 16px 24px 16px}
  .r-subject{display:flex;align-items:flex-start;gap:8px;padding:20px 0 8px 56px}
  .r-subject-main{flex:1;min-width:0;display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px}
  .r-subject h2{font-size:22px;font-weight:400;line-height:28px;color:#1f1f1f;word-break:break-word;margin-right:4px}
  .r-chip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 2px 0 6px;border-radius:4px;font-size:12px;line-height:20px;background:#dde3ea;color:#444746;white-space:nowrap}
  .r-chip.no-x{padding-right:6px}
  .r-chip .x{width:16px;height:16px;border-radius:2px;display:inline-flex;align-items:center;justify-content:center;opacity:.6;cursor:pointer}
  .r-chip .x:hover{opacity:1;background:rgba(0,0,0,.08)}
  .r-chip .x svg{width:12px;height:12px}
  .r-chip.acc{font-weight:500}
  .r-chip.acc .dot{width:8px;height:8px;border-radius:50%}
  .r-imp{width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#444746;opacity:.7}
  .r-imp:hover{opacity:1;background:rgba(68,71,70,.08)}
  .r-imp.on{color:#f4b400;opacity:1}
  .r-subject-tools{display:flex;align-items:center;margin-top:-4px}

  .msg{border-top:1px solid #e0e0e0;margin-left:0}
  .msg + .msg{margin-left:0}
  .msg:first-child{border-top:0}
  .msg-head{display:flex;align-items:flex-start;gap:16px;padding:16px 0 4px;cursor:pointer}
  .msg:not(.open) .msg-head{padding:12px 0;align-items:center}
  .avatar{border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:500;flex-shrink:0;overflow:hidden}
  .avatar img{width:100%;height:100%;object-fit:cover}
  .who{flex:1;min-width:0}
  .who .line1{display:flex;align-items:baseline;flex-wrap:wrap;column-gap:4px;line-height:20px}
  .who .name{font-weight:700;font-size:14px;color:#1f1f1f;white-space:nowrap}
  .who .addr{font-size:12px;color:#5e5e5e;white-space:nowrap}
  .who .unsub-link{font-size:12px;color:#444746;text-decoration:underline;margin-left:8px;cursor:pointer;white-space:nowrap}
  .who .unsub-link:hover{color:#0b57d0}
  .who .line2{font-size:12px;color:#5e5e5e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:20px}
  .who .line2.to{white-space:normal;overflow:visible;word-break:break-word;display:flex;align-items:center;flex-wrap:wrap}
  .det-btn{width:20px;height:20px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;color:#444746;margin-left:2px}
  .det-btn:hover{background:rgba(68,71,70,.08)}
  .det-box{margin-top:6px;padding:8px 12px;border:1px solid #e0e0e0;border-radius:8px;box-shadow:0 1px 3px rgba(60,64,67,.15);background:#fff;width:max-content;max-width:100%;cursor:default}
  .details{border-collapse:collapse;font-size:12px;color:#1f1f1f}
  .details td{padding:2px 0;vertical-align:top;word-break:break-word}
  .details .k{color:#5e5e5e;text-align:right;padding-right:12px;white-space:nowrap}
  .msg:not(.open) .exp-only{display:none!important}
  .msg.open .col-only{display:none!important}
  .meta{display:flex;align-items:center;gap:0;flex-shrink:0;margin-top:-6px}
  .msg:not(.open) .meta{margin-top:0}
  .when{font-size:12px;color:#5e5e5e;white-space:nowrap;padding-right:8px}
  .meta .ib{width:36px;height:36px}
  .meta .ib svg{width:20px;height:20px}
  .meta .star.on{color:#f4b400}
  .msg-body{padding:8px 0 16px 56px}
  .msg-body iframe{display:block;width:100%;border:0;min-height:40px;background:#fff}
  .plain{white-space:pre-wrap;word-break:break-word;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222}
  .plain a{color:#0b57d0}
  .quote-toggle{display:inline-flex;align-items:center;justify-content:center;width:24px;height:12px;border-radius:6px;background:#e8eaed;color:#444746;font-size:11px;line-height:1;margin-top:6px}
  .quote-toggle:hover{background:#dadce0}
  .atts{display:flex;flex-wrap:wrap;gap:16px;padding:12px 0 16px;margin-left:56px;border-top:1px solid #e0e0e0}
  .atts-head{width:100%;font-size:14px;font-weight:500;color:#1f1f1f}
  .att{position:relative;width:180px;height:120px;border:1px solid #dadce0;border-radius:8px;overflow:hidden;cursor:pointer;background:#f8fafd}
  .att-thumb{position:absolute;inset:0 0 40px 0;display:flex;align-items:center;justify-content:center;background:#f1f3f4 center/cover no-repeat}
  .att-big{display:flex;opacity:.85}
  .att-foot{position:absolute;left:0;right:0;bottom:0;height:40px;display:flex;align-items:center;gap:8px;padding:0 10px;background:#fff;border-top:1px solid #e0e0e0}
  .att-ic{display:flex}
  .att-name{flex:1;min-width:0;font-size:13px;font-weight:500;color:#1f1f1f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .att-hover{position:absolute;inset:0;display:none;flex-direction:column;justify-content:space-between;padding:10px;background:rgba(0,0,0,.6);color:#fff}
  .att:hover .att-hover{display:flex}
  .att-hname{font-size:13px;font-weight:500;word-break:break-all;max-height:56px;overflow:hidden}
  .att-hover .ib{color:#fff;align-self:flex-start;background:rgba(255,255,255,.15)}
  .att-hover .ib:hover{background:rgba(255,255,255,.3);color:#fff}
  .r-reply{display:flex;gap:12px;padding:16px 0 24px 56px}
  .code-card{margin:4px 0 8px 56px;max-width:1200px;padding:16px 24px 20px;border-radius:16px;background:#edf2fa}
  .cc-title{font-size:14px;color:#444746;margin-bottom:12px}
  .cc-chars{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .cc-ch{min-width:26px;height:40px;padding:0 4px;border-radius:4px;background:#fff;display:inline-flex;align-items:center;justify-content:center;font:400 24px/1 "Google Sans Mono","Roboto Mono",monospace;color:#1f1f1f;user-select:all}
  .cc-gap{width:8px}
  .cc-copy{display:inline-flex;align-items:center;gap:8px;height:40px;margin-top:16px;padding:0 24px 0 20px;border-radius:20px;background:#0b57d0;color:#fff;font-size:14px;font-weight:500}
  .cc-copy:hover{background:#0a4fbf;box-shadow:0 1px 2px rgba(0,0,0,.3),0 1px 3px 1px rgba(0,0,0,.15)}
  .cc-copy.done{background:#146c2e}
  .cc-note{margin:0 0 8px 56px;font-size:12px;color:#444746}
  .code-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px 0 8px;margin:0;border-radius:12px;background:#0b57d0;color:#fff;font:500 13px/1 "Google Sans Mono","Roboto Mono",monospace;flex-shrink:0;letter-spacing:1px}
  .code-chip:hover{background:#0a4fbf;box-shadow:0 1px 2px rgba(0,0,0,.3)}
  .code-chip.done{background:#146c2e}
  .code-chip svg{width:14px;height:14px}
  .pill{height:36px;padding:0 20px 0 16px;border-radius:18px;border:1px solid #747775;display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:500;color:#444746}
  .pill:hover{background:rgba(68,71,70,.08)}
  .loading{display:flex;align-items:center;gap:12px;padding:32px 0;color:#444746}
  .loading .ring{width:20px;height:20px;border:2px solid #d3e3fd;border-top-color:#0b57d0;border-radius:50%;animation:spin .8s linear infinite}
`;

function mountView() {
  if (!hosts.viewHost) {
    const host = document.createElement('div');
    host.id = 'ui-unified-view';
    host.style.cssText = 'all:initial;display:none;flex:1;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;background:#fff;border-radius:16px;position:relative;';
    const root = host.attachShadow({ mode: 'open' });
    buildViewDOM(root);
    isolateEvents(host);
    hosts.viewHost = host;
    hosts.view = root;
  }

  const host = hosts.viewHost;
  host.classList.toggle('compact', state.compact);
  if (!host.isConnected) {
    const nativeMain = [...document.querySelectorAll('[role="main"]')].find(el => el !== host);
    const parent = nativeMain?.parentElement || document.querySelector('.aeF') || document.body;
    parent.appendChild(host);
  }
  return host;
}

function buildViewDOM(root) {
  root.innerHTML = `
  <style>${VIEW_CSS}</style>

  <div class="view" id="list-view">
    <div class="toolbar">
      <div class="cb-wrap">
        <span class="cb" id="master-cb" data-act="master" role="checkbox" title="Select">
          <svg class="i-check" viewBox="0 0 24 24"><path d="${ICONS.check}"/></svg>
          <svg class="i-minus" viewBox="0 0 24 24"><path d="${ICONS.minus}"/></svg>
        </span>
        <span class="caret" data-act="sel-menu" title="Select">${icon('arrow_drop_down')}</span>
      </div>
      <div class="tb-group" id="tb-idle">
        <button class="ib" id="btn-refresh" data-act="refresh" title="Refresh">${icon('refresh')}</button>
        <button class="compose-btn" data-act="compose" title="Compose (c)">${icon('edit')}<span>Compose</span></button>
      </div>
      <div class="tb-group" id="tb-bulk" hidden>
        <button class="ib" data-act="bulk-archive" title="Archive (e)">${icon('archive')}</button>
        <button class="ib" data-act="bulk-spam" title="Report spam (!)">${icon('spam')}</button>
        <button class="ib" data-act="bulk-trash" title="Delete (#)">${icon('delete')}</button>
        <span class="sep"></span>
        <button class="ib" id="bulk-read" data-act="bulk-read" title="Mark as read (Shift+I)">${icon('drafts')}</button>
        <button class="ib" id="bulk-unread" data-act="bulk-unread" title="Mark as unread (Shift+U)">${icon('mail')}</button>
        <button class="ib" data-act="bulk-snooze" title="Snooze (b)">${icon('schedule')}</button>
        <button class="ib" id="bulk-move" data-act="bulk-move" title="Move to">${icon('label')}</button>
      </div>
      <div class="spacer"></div>
      <div class="pager">
        <span id="page-info"></span>
        <button class="ib" id="prev-page" data-act="prev-page" title="Newer">${icon('chevron_left')}</button>
        <button class="ib" id="next-page" data-act="next-page" title="Older">${icon('chevron_right')}</button>
      </div>
      <button class="sort-btn" id="btn-sort" data-act="sort" title="Sort conversations">${icon('sort')}<span id="sort-label"></span></button>
      <button class="ib" id="btn-density" data-act="density" title="Density">${icon('density')}</button>
    </div>
    <div id="notices"></div>
    <div id="searchbar"></div>
    <div class="tabs" id="tabs" role="tablist"></div>
    <div id="selbar"></div>
    <div class="scroll" id="list-scroll"><div id="rows" role="grid"></div></div>
  </div>

  <div class="view" id="reader-view" hidden>
    <div class="toolbar">
      <button class="ib" data-act="back" title="Back to All Inboxes (u)">${icon('arrow_back')}</button>
      <span class="sep"></span>
      <button class="ib" data-act="r-archive" title="Archive (e)">${icon('archive')}</button>
      <button class="ib" data-act="r-spam" title="Report spam (!)">${icon('spam')}</button>
      <button class="ib" data-act="r-trash" title="Delete (#)">${icon('delete')}</button>
      <span class="sep"></span>
      <button class="ib" data-act="r-unread" title="Mark as unread (Shift+U)">${icon('mail')}</button>
      <button class="ib" data-act="r-snooze" title="Snooze (b)">${icon('schedule')}</button>
      <span class="sep"></span>
      <button class="ib" data-act="r-move" title="Move to">${icon('move_to')}</button>
      <button class="ib" data-act="r-label" title="Labels">${icon('label')}</button>
      <button class="ib" data-act="r-more" title="More">${icon('more_vert')}</button>
      <div class="spacer"></div>
      <div class="pager">
        <span id="r-pos"></span>
        <button class="ib" id="r-newer" data-act="r-newer" title="Newer (k)">${icon('chevron_left')}</button>
        <button class="ib" id="r-older" data-act="r-older" title="Older (j)">${icon('chevron_right')}</button>
      </div>
    </div>
    <div class="scroll" id="reader-scroll">
      <div class="r-wrap">
        <div class="r-subject">
          <div class="r-subject-main" id="r-subject-main"></div>
          <div class="r-subject-tools">
            <button class="ib" data-act="r-print" title="Print all">${icon('print')}</button>
            <button class="ib" data-act="r-open-gmail" title="Open in this account's Gmail">${icon('open_in_new')}</button>
          </div>
        </div>
        <div id="r-code"></div>
        <div id="r-msgs"></div>
        <div id="r-composer"></div>
        <div class="r-reply" id="r-reply">
          <button class="pill" data-act="reply">${icon('reply')} Reply</button>
          <button class="pill" data-act="reply-all">${icon('reply_all')} Reply all</button>
          <button class="pill" data-act="forward">${icon('forward')} Forward</button>
        </div>
      </div>
    </div>
  </div>`;

  root.addEventListener('click', onViewClick);
  root.addEventListener('dragstart', onRowDragStart);
  root.addEventListener('contextmenu', onRowContextMenu);
  root.addEventListener('dragend', () => setTimeout(hideDropPanel, 0));
  installImageFallback(root);
}

// ─── List rendering ──────────────────────────────────────────────
function senderHtml(email) {
  const senders = email.senders || [];
  if (!senders.length) return '(unknown)';
  const many = senders.length > 1;
  const names = senders.map(s => {
    const label = s.isMe ? 'me' : many ? firstName(s.name || s.email) : (s.name || s.email);
    return `<span class="${s.unread ? 'u' : ''}">${esc(label)}</span>`;
  }).join(', ');
  return names + (email.messageCount > 1 ? `<span class="count">${email.messageCount}</span>` : '');
}

function rowHtml(email, index) {
  const acc = accountOf(email);
  const selected = state.selected.has(email.key);
  const labelChips = (email.labelIds || []).map(id => {
    const l = (acc.labels || []).find(x => x.id === id);
    return l ? `<span class="chip lbl"${l.color ? ` style="background:${esc(l.color)};color:${esc(l.textColor || '#1f1f1f')}"` : ''}>${esc(l.name)}</span>` : '';
  }).join('');
  const accChip = state.filter === 'all' && state.accounts.length > 1
    ? `<span class="chip acc" style="background:${softColor(acc.color, 0.14)};color:${acc.color}" title="${esc(acc.email)}">${esc(acc.name)}</span>`
    : '';

  return `
  <div class="row ${email.unread ? 'unread' : 'read'}${selected ? ' selected' : ''}${index === state.focusIndex ? ' focused' : ''}" data-key="${esc(email.key)}" role="row" draggable="true">
    <span class="stripe" style="background:${acc.color}" title="${esc(acc.name)} · ${esc(acc.email)}"></span>
    <span class="c-cb" data-act="row-select" title="Select"><span class="cb${selected ? ' checked' : ''}"><svg class="i-check" viewBox="0 0 24 24"><path d="${ICONS.check}"/></svg></span></span>
    <span class="c-star${email.starred ? ' on' : ''}" data-act="row-star" title="${email.starred ? 'Starred' : 'Not starred'}">${icon(email.starred ? 'star' : 'star_border')}</span>
    <span class="c-imp${email.important ? ' on' : ''}" data-act="row-important" title="${email.important ? 'Important' : 'Mark as important'}">${icon(email.important ? 'important' : 'important_border')}</span>
    <span class="c-from">
      <span class="from-names">${senderHtml(email)}</span>
      ${(() => { const code = rowCode(email); return code ? `<button class="code-chip" data-act="copy-code" data-code="${esc(code.value)}" title="Copy code ${esc(code.value)}">${icon('content_copy', 14)}<span>${esc(code.display)}</span></button>` : ''; })()}
    </span>
    <span class="c-main">
      ${accChip}${email.category ? `<span class="chip lbl" title="Gmail category">${CATEGORY_NAMES[email.category]}</span>` : ''}${labelChips}

      <span class="text">
        <span class="subj">${esc(email.subject)}</span>
        <span class="snip">&nbsp;- ${esc(decodeEntities(email.snippet))}</span>
      </span>
    </span>
    ${email.unsubscribe ? '<button class="unsub" data-act="row-unsub" title="Unsubscribe">Unsubscribe</button>' : ''}
    ${email.hasAttachment ? `<span class="c-att" title="Has attachments">${icon('attach', 18)}</span>` : ''}
    <span class="c-date" title="${esc(fullDate(email.internalDate))}">${esc(listDate(email.internalDate))}</span>
    <span class="c-actions">
      <button class="ib" data-act="row-archive" title="Archive">${icon('archive')}</button>
      <button class="ib" data-act="row-trash" title="Delete">${icon('delete')}</button>
      <button class="ib" data-act="row-toggle-read" title="${email.unread ? 'Mark as read' : 'Mark as unread'}">${icon(email.unread ? 'drafts' : 'mail')}</button>
      <button class="ib" data-act="row-snooze" title="Snooze">${icon('schedule')}</button>
      <button class="ib" data-act="row-open-gmail" title="Open in this account's Gmail">${icon('open_in_new')}</button>
    </span>
  </div>`;
}

function renderNotices() {
  const root = hosts.view;
  const expired = state.accounts.filter(a => a.needsReauth && (state.filter === 'all' || state.filter === a.id));
  root.getElementById('notices').innerHTML = expired.map(a => `
    <div class="notice" data-id="${esc(a.id)}">
      ${icon('warning')}
      <span>The session for <b>${esc(a.email)}</b> has expired. This account's emails aren't being updated.</span>
      <span class="spacer"></span>
      <button data-act="notice-reauth">Sign in</button>
    </div>`).join('');
}

function renderSearchBar() {
  const bar = hosts.view.getElementById('searchbar');
  if (state.searchQuery === null) { bar.innerHTML = ''; return; }
  const n = filteredEmails().length;
  bar.innerHTML = `
    <div class="searchbar">
      ${icon('search')}
      <span>${state.searching ? 'Searching' : 'Results for'} <b>${esc(state.searchQuery)}</b> ${esc(state.searchScopeLabel || 'in all accounts')}${state.searching ? '…' : ` · ${n} conversation${n === 1 ? '' : 's'}`}</span>
      <span class="spacer"></span>
      <button data-act="clear-search">Clear search</button>
    </div>`;
}

function renderTabs() {
  const root = hosts.view;
  const tabs = root.getElementById('tabs');
  if (state.accounts.length === 0) { tabs.hidden = true; return; }
  tabs.hidden = false;

  const searching = state.searchQuery !== null;
  const pool = currentPool();
  const unreadOf = (id) => searching ? 0 : id === 'all' ? totalUnread() : (getAccount(id)?.inboxUnread || 0);
  const totalOf = (id) => id === 'all' ? pool.length : pool.filter(e => e.accountId === id).length;
  const tab = (id, label, color, ic, title) => {
    const n = unreadOf(id);
    const total = totalOf(id);
    return `
      <div class="tab${state.filter === id ? ' active' : ''}" data-nav="${esc(id)}" style="--c:${color}" role="tab" title="${esc(title)}">
        <span class="t-ic"${state.filter === id ? '' : ` style="color:${id === 'all' ? '#444746' : color}"`}>${icon(ic)}</span>
        <span class="t-label">${esc(label)}</span>
        ${n ? `<span class="t-new" style="background:${color}">${n} new</span>` : ''}
        <span class="t-total" title="${total} conversations shown">${total.toLocaleString(LOCALE)}</span>
      </div>`;
  };
  tabs.innerHTML = tab('all', 'All', '#0b57d0', 'all_inbox', 'All accounts') +
    state.accounts.map(a => tab(a.id, a.name || a.email, a.color, 'label', a.email)).join('');
}

function renderList() {
  const root = hosts.view;
  if (!root) return;
  const listView = root.getElementById('list-view');
  listView.hidden = false;
  root.getElementById('reader-view').hidden = true;

  renderNotices();
  renderSearchBar();
  renderTabs();
  const { all, items } = pageEmails();
  const rows = root.getElementById('rows');
  const start = state.page * PAGE_SIZE;

  root.getElementById('page-info').textContent = all.length
    ? `${(start + 1).toLocaleString(LOCALE)}–${(start + items.length).toLocaleString(LOCALE)} of ${all.length.toLocaleString(LOCALE)}`
    : '';
  root.getElementById('prev-page').disabled = state.page === 0;
  root.getElementById('next-page').disabled = start + items.length >= all.length;
  root.getElementById('btn-density').title = state.compact ? 'Density: compact' : 'Density: default';
  root.getElementById('sort-label').textContent = SORT_MODES[state.sortMode];

  if (state.accounts.length === 0) {
    rows.innerHTML = `
      <div class="empty">
        ${icon('all_inbox')}
        <h3>Connect your Google accounts</h3>
        <p>Bring the inboxes of all your Gmail accounts into one list, without switching tabs.</p>
        <button class="btn-filled" data-act="add-account">${icon('person_add')} Add Google account</button>
      </div>`;
  } else if (items.length === 0) {
    const firstSync = !state.lastSync && !state.rawEmails.length;
    rows.innerHTML = firstSync
      ? '<div class="empty"><div class="loading"><span class="ring"></span>Loading inboxes…</div></div>'
      : state.searchQuery !== null
        ? (state.searching
          ? '<div class="empty"><div class="loading"><span class="ring"></span>Searching all accounts…</div></div>'
          : `<div class="empty">${icon('search')}<p>No conversations match “${esc(state.searchQuery)}”.</p></div>`)
        : `<div class="empty">${icon('all_inbox')}<h3>You're all caught up!</h3><p>There are no conversations in the inbox.</p></div>`;
  } else {
    if (state.focusIndex >= items.length) state.focusIndex = items.length - 1;
    const grouped = state.filter === 'all' && state.sortMode.startsWith('account');
    rows.innerHTML = items.map((e, i) => {
      if (!grouped || (i > 0 && items[i - 1].accountId === e.accountId)) return rowHtml(e, i);
      const acc = accountOf(e);
      const count = all.filter(x => x.accountId === e.accountId).length;
      return `<div class="group-head" style="--c:${acc.color}"><span class="gh-dot"></span>${esc(acc.name || acc.email)}<span class="gh-mail">${esc(acc.email)}</span><span class="gh-n">${count}</span></div>${rowHtml(e, i)}`;
    }).join('') + `
      ${start + items.length >= all.length && canLoadMore() ? `
        <div class="load-more-wrap">
          <button class="load-more" data-act="load-more"${state.loadingMore ? ' disabled' : ''}>${state.loadingMore ? '<span class="ring"></span> Loading older conversations…' : 'Load older conversations'}</button>
        </div>` : ''}
      <div class="footer">
        <span>${state.accounts.length} ${state.accounts.length === 1 ? 'account' : 'accounts'} · ${all.length} conversations</span>
        <span>${state.lastSync ? `Last synced ${relativeTime(state.lastSync)}` : ''}</span>
      </div>`;
  }
  updateSelectionUI();
}

function canLoadMore() {
  if (state.searchQuery !== null) return false;
  return state.accounts.some(a => a.hasMore && (state.filter === 'all' || state.filter === a.id));
}

async function loadMore() {
  if (state.loadingMore) return;
  state.loadingMore = true;
  renderList();
  const res = await send({ type: 'LOAD_MORE', accountIds: state.filter === 'all' ? [] : [state.filter] });
  state.loadingMore = false;
  if (!res.success) toast(`Couldn't load more: ${res.error}`);
  renderList();
}

function renderSelectionBar(items, all) {
  const bar = hosts.view.getElementById('selbar');
  const pageAll = items.length > 0 && items.every(e => state.selected.has(e.key));
  const everything = all.length > 0 && all.every(e => state.selected.has(e.key));
  const where = state.searchQuery !== null ? 'these search results'
    : state.filter === 'all' ? 'All Inboxes' : (getAccount(state.filter)?.name || 'this inbox');
  if (everything && all.length > items.length) {
    bar.innerHTML = `<div class="selbar">All <b>${all.length}</b> conversations in ${esc(where)} are selected. <button data-act="clear-selection">Clear selection</button></div>`;
  } else if (pageAll && all.length > items.length) {
    bar.innerHTML = `<div class="selbar">All <b>${items.length}</b> conversations on this page are selected. <button data-act="select-all-matching">Select all ${all.length} conversations in ${esc(where)}</button></div>`;
  } else {
    bar.innerHTML = '';
  }
}

function updateSelectionUI() {
  const root = hosts.view;
  if (!root) return;
  const { items, all } = pageEmails();
  renderSelectionBar(items, all);
  const selected = items.filter(e => state.selected.has(e.key));
  const master = root.getElementById('master-cb');
  master.classList.toggle('checked', selected.length > 0 && selected.length === items.length);
  master.classList.toggle('partial', selected.length > 0 && selected.length < items.length);

  // Bulk actions apply to the whole selection (may span pages after "Select all N")
  const allSelected = selectedEmails();
  root.getElementById('tb-bulk').hidden = allSelected.length === 0;
  root.getElementById('tb-idle').hidden = allSelected.length > 0;
  const anyUnread = allSelected.some(e => e.unread);
  root.getElementById('bulk-read').hidden = !anyUnread;
  root.getElementById('bulk-unread').hidden = anyUnread;
  root.getElementById('bulk-move').hidden = new Set(allSelected.map(e => e.accountId)).size !== 1;

  root.querySelectorAll('.row').forEach(row => {
    const on = state.selected.has(row.dataset.key);
    row.classList.toggle('selected', on);
    row.querySelector('.cb')?.classList.toggle('checked', on);
  });
}

function setFocus(index) {
  const root = hosts.view;
  const rows = [...root.querySelectorAll('.row')];
  if (!rows.length) return;
  state.focusIndex = Math.max(0, Math.min(index, rows.length - 1));
  rows.forEach((r, i) => r.classList.toggle('focused', i === state.focusIndex));
  rows[state.focusIndex].scrollIntoView({ block: 'nearest' });
}

function emailByKey(key) {
  return currentPool().find(e => e.key === key) || state.emails.find(e => e.key === key);
}

function selectedEmails() {
  return currentPool().filter(e => state.selected.has(e.key));
}

// ─── View click handling ─────────────────────────────────────────
async function onViewClick(e) {
  const actEl = e.target.closest('[data-act]');
  const act = actEl?.dataset.act;
  const rowEl = e.target.closest('.row');
  const email = rowEl ? emailByKey(rowEl.dataset.key) : null;

  if (!act) {
    const nav = e.target.closest('[data-nav]')?.dataset.nav;
    if (nav) {
      state.page = 0;
      navigate(nav, null);
      return;
    }
    if (rowEl && email) {
      navigate(state.filter, email.key);
    }
    return;
  }

  e.stopPropagation();
  if (act.startsWith('cmp-')) { onComposerAction(act, actEl); return; }
  switch (act) {
    // toolbar
    case 'master': {
      const { items } = pageEmails();
      const allSelected = items.length && items.every(i => state.selected.has(i.key));
      if (allSelected || state.selected.size) state.selected.clear();
      else items.forEach(i => state.selected.add(i.key));
      updateSelectionUI();
      break;
    }
    case 'sel-menu': {
      const pick = (fn) => () => {
        const { items } = pageEmails();
        state.selected.clear();
        items.filter(fn).forEach(i => state.selected.add(i.key));
        updateSelectionUI();
      };
      showMenu(actEl, {
        items: [
          { label: 'All', onClick: pick(() => true) },
          { label: 'None', onClick: pick(() => false) },
          { label: 'Read', onClick: pick(i => !i.unread) },
          { label: 'Unread', onClick: pick(i => i.unread) },
          { label: 'Starred', onClick: pick(i => i.starred) },
          { label: 'Unstarred', onClick: pick(i => !i.starred) },
          ...(state.filter === 'all' && state.accounts.length > 1 ? [{ sep: true }, ...state.accounts.map(a => ({
            label: a.name || a.email, dot: a.color, onClick: pick(i => i.accountId === a.id)
          }))] : [])
        ]
      });
      break;
    }
    case 'refresh': syncNow(); break;
    case 'sort':
      showMenu(actEl, {
        title: 'Sort conversations',
        items: Object.entries(SORT_MODES).map(([mode, label]) => ({
          label: `${state.sortMode === mode ? '✓ ' : ''}${label}`,
          onClick: () => {
            state.sortMode = mode;
            state.page = 0;
            state.focusIndex = -1;
            saveUiPrefs();
            renderList();
            hosts.view.getElementById('list-scroll').scrollTop = 0;
          }
        }))
      });
      break;
    case 'load-more': loadMore(); break;
    case 'select-all-matching': filteredEmails().forEach(e => state.selected.add(e.key)); updateSelectionUI(); break;
    case 'clear-selection': state.selected.clear(); updateSelectionUI(); break;
    case 'clear-search': clearSearch(); break;
    case 'prev-page': state.page--; state.focusIndex = -1; renderList(); hosts.view.getElementById('list-scroll').scrollTop = 0; break;
    case 'next-page': state.page++; state.focusIndex = -1; renderList(); hosts.view.getElementById('list-scroll').scrollTop = 0; break;
    case 'density':
      state.compact = !state.compact;
      hosts.viewHost.classList.toggle('compact', state.compact);
      saveUiPrefs();
      renderList();
      break;
    case 'bulk-archive': runAction(selectedEmails(), 'archive'); break;
    case 'bulk-spam': runAction(selectedEmails(), 'spam'); break;
    case 'bulk-trash': runAction(selectedEmails(), 'trash'); break;
    case 'bulk-read': runAction(selectedEmails(), 'read'); break;
    case 'bulk-unread': runAction(selectedEmails(), 'unread'); break;
    case 'bulk-move': showMoveMenu(actEl, selectedEmails()); break;
    case 'bulk-snooze': showSnoozeMenu(actEl, selectedEmails()); break;
    case 'row-snooze': showSnoozeMenu(actEl, [email]); break;
    case 'r-snooze': {
      const current = readingEmail();
      if (current) showSnoozeMenu(actEl, [current], () => navigate(state.filter, null));
      break;
    }
    case 'add-account': addAccount(); break;
    case 'notice-reauth': reauth(getAccount(actEl.closest('[data-id]')?.dataset.id)); break;

    // rows
    case 'row-select':
      if (state.selected.has(email.key)) state.selected.delete(email.key);
      else state.selected.add(email.key);
      updateSelectionUI();
      break;
    case 'row-star': runAction([email], email.starred ? 'unstar' : 'star'); break;
    case 'row-important': runAction([email], email.important ? 'unimportant' : 'important'); break;
    case 'row-archive': runAction([email], 'archive'); break;
    case 'row-trash': runAction([email], 'trash'); break;
    case 'row-toggle-read': runAction([email], email.unread ? 'read' : 'unread'); break;
    case 'row-open-gmail': window.open(gmailThreadUrl(accountOf(email), email.id), '_blank'); break;
    case 'row-unsub': unsubscribe(email); break;

    // reader
    case 'back': navigate(state.filter, null); break;
    case 'r-archive': readerAction('archive'); break;
    case 'r-spam': readerAction('spam'); break;
    case 'r-trash': readerAction('trash'); break;
    case 'r-unread': readerAction('unread'); break;
    case 'r-move': {
      const current = readingEmail();
      if (current) showMoveMenu(actEl, [current], () => navigate(state.filter, null));
      break;
    }
    case 'r-newer': stepReader(-1); break;
    case 'r-older': stepReader(1); break;
    case 'r-open-gmail': {
      const current = readingEmail();
      if (current) window.open(gmailThreadUrl(accountOf(current), current.id), '_blank');
      break;
    }
    case 'reply': openReply('reply'); break;
    case 'reply-all': openReply('replyAll'); break;
    case 'forward': openReply('forward'); break;
    case 'msg-reply': openReply('reply', actEl.closest('.msg')?.dataset.mid); break;
    case 'compose': openCompose(); break;
    case 'r-star':
    case 'msg-star': {
      const current = readingEmail();
      if (current) runAction([current], current.starred ? 'unstar' : 'star');
      break;
    }
    case 'r-important': {
      const current = readingEmail();
      if (current) runAction([current], current.important ? 'unimportant' : 'important');
      break;
    }
    case 'r-chip-inbox': readerAction('archive'); break;
    case 'r-chip-label': {
      const current = readingEmail();
      if (current) runAction([current], 'unlabel', { labelId: actEl.dataset.label });
      break;
    }
    case 'r-label': {
      const current = readingEmail();
      if (current) showLabelMenu(actEl, current);
      break;
    }
    case 'r-unsub': {
      const current = readingEmail();
      if (current) unsubscribe(current);
      break;
    }
    case 'r-print': printThread(); break;
    case 'r-more': {
      const current = readingEmail();
      if (!current) break;
      showMenu(actEl, {
        items: [
          { label: 'Mark as unread', onClick: () => readerAction('unread') },
          { label: current.important ? 'Mark as not important' : 'Mark as important', onClick: () => runAction([current], current.important ? 'unimportant' : 'important') },
          { label: current.starred ? 'Remove star' : 'Add star', onClick: () => runAction([current], current.starred ? 'unstar' : 'star') },
          ...(current.unsubscribe ? [{ label: 'Unsubscribe', onClick: () => unsubscribe(current) }] : []),
          { sep: true },
          { label: 'Remind me if no reply in 1 day', icon: 'bell', onClick: () => remindIfNoReply(current, 1) },
          { label: 'Remind me if no reply in 3 days', icon: 'bell', onClick: () => remindIfNoReply(current, 3) },
          { label: 'Remind me if no reply in 1 week', icon: 'bell', onClick: () => remindIfNoReply(current, 7) },
          { sep: true },
          { label: 'Open in Gmail', onClick: () => window.open(gmailThreadUrl(accountOf(current), current.id), '_blank') }
        ]
      });
      break;
    }
    case 'msg-more': {
      const current = readingEmail();
      if (!current) break;
      const url = gmailThreadUrl(accountOf(current), current.id);
      const mid = actEl.closest('.msg')?.dataset.mid;
      showMenu(actEl, {
        items: [
          { label: 'Reply', icon: 'reply', onClick: () => openReply('reply', mid) },
          { label: 'Reply all', icon: 'reply_all', onClick: () => openReply('replyAll', mid) },
          { label: 'Forward', icon: 'forward', onClick: () => openReply('forward', mid) },
          { sep: true },
          { label: 'Mark as unread from here', onClick: () => readerAction('unread') },
          { label: 'Print', onClick: printThread },
          { label: 'Open in Gmail', onClick: () => window.open(url, '_blank') }
        ]
      });
      break;
    }
    case 'toggle-msg': {
      const msgEl = actEl.closest('.msg');
      if (!msgEl || e.target.closest('.msg-tools, .det-box')) break;
      msgEl.classList.toggle('open');
      if (msgEl.classList.contains('open')) { mountMessageBody(msgEl); loadThumbnails(msgEl); }
      break;
    }
    case 'copy-code': copyCode(actEl); break;
    case 'msg-details': {
      const box = actEl.closest('.who')?.querySelector('.det-box');
      if (box) box.hidden = !box.hidden;
      break;
    }
    case 'download': downloadAttachment(actEl.dataset.mid, Number(actEl.dataset.idx)); break;
    case 'preview': openViewer(actEl.dataset.mid, Number(actEl.dataset.idx)); break;
    case 'toggle-quotes': {
      const doc = actEl.previousElementSibling?.contentDocument;
      if (doc) {
        doc.documentElement.classList.toggle('hide-quotes');
        fitIframe(actEl.previousElementSibling);
      }
      break;
    }
  }
}

function showMoveMenu(anchor, emails, after) {
  const accountIds = new Set(emails.map(e => e.accountId));
  if (accountIds.size !== 1) {
    toast('Select conversations from a single account to move them to a label.');
    return;
  }
  const acc = getAccount([...accountIds][0]);
  const labels = acc?.labels || [];
  showMenu(anchor, {
    title: `Move to (${acc.name}):`,
    filterPlaceholder: labels.length > 6 ? 'Search labels' : null,
    empty: 'This account has no labels.',
    items: [
      ...labels.map(l => ({
        label: l.name,
        dot: l.color || acc.color,
        onClick: async () => {
          const ok = await runAction(emails, 'move', { labelId: l.id, labelName: l.name });
          if (ok && after) after();
        }
      })),
      { sep: true },
      { label: 'Create new label…', icon: 'add', onClick: async () => {
        const label = await createLabelPrompt(acc);
        if (!label) return;
        const ok = await runAction(emails, 'move', { labelId: label.id, labelName: label.name });
        if (ok && after) after();
      } }
    ]
  });
}

function showLabelMenu(anchor, emails) {
  emails = [].concat(emails).filter(Boolean);
  if (new Set(emails.map(e => e.accountId)).size !== 1) {
    toast('Select conversations from a single account to label them.');
    return;
  }
  const acc = accountOf(emails[0]);
  const labels = acc.labels || [];
  showMenu(anchor, {
    title: 'Label as:',
    filterPlaceholder: labels.length > 6 ? 'Search labels' : null,
    empty: 'This account has no labels.',
    items: [
      ...labels.map(l => {
        const all = emails.every(e => (e.labelIds || []).includes(l.id));
        return {
          label: `${all ? '✓ ' : ''}${l.name}`,
          dot: l.color || acc.color,
          onClick: () => runAction(emails, all ? 'unlabel' : 'label', { labelId: l.id, labelName: l.name })
        };
      }),
      { sep: true },
      { label: 'Create new label…', icon: 'add', onClick: async () => {
        const label = await createLabelPrompt(acc);
        if (label) runAction(emails, 'label', { labelId: label.id, labelName: label.name });
      } }
    ]
  });
}

// ─── Right-click menu (same actions as Gmail's) ──────────────────
function pointAnchor(x, y) {
  return { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }) };
}

function onRowContextMenu(e) {
  const row = e.target.closest?.('.row');
  const email = row && emailByKey(row.dataset.key);
  if (!email) return;
  e.preventDefault();

  // Like Gmail: right-clicking an unselected row selects just that row
  if (!state.selected.has(email.key)) {
    state.selected.clear();
    state.selected.add(email.key);
    updateSelectionUI();
  }
  const targets = selectedEmails();
  const single = targets.length === 1 ? targets[0] : null;
  const oneAccount = new Set(targets.map(t => t.accountId)).size === 1;
  const anyUnread = targets.some(t => t.unread);
  const allStarred = targets.every(t => t.starred);
  const allImportant = targets.every(t => t.important);
  const sender = single?.senders?.find(x => !x.isMe) || single?.senders?.[0];
  const at = pointAnchor(e.clientX, e.clientY);
  const openGmail = () => targets.forEach(t => window.open(gmailThreadUrl(accountOf(t), t.id), '_blank'));

  showMenu(at, {
    items: [
      ...(single ? [
        { label: 'Reply', icon: 'reply', onClick: () => { state.pendingCompose = 'reply'; navigate(state.filter, single.key); } },
        { label: 'Reply all', icon: 'reply_all', onClick: () => { state.pendingCompose = 'replyAll'; navigate(state.filter, single.key); } },
        { label: 'Forward', icon: 'forward', onClick: () => { state.pendingCompose = 'forward'; navigate(state.filter, single.key); } },
        { sep: true }
      ] : []),
      { label: 'Archive', icon: 'archive', onClick: () => runAction(targets, 'archive') },
      { label: 'Delete', icon: 'delete', onClick: () => runAction(targets, 'trash') },
      { label: anyUnread ? 'Mark as read' : 'Mark as unread', icon: anyUnread ? 'drafts' : 'mail', onClick: () => runAction(targets, anyUnread ? 'read' : 'unread') },
      { label: allImportant ? 'Mark as not important' : 'Mark as important', icon: allImportant ? 'important_border' : 'important', onClick: () => runAction(targets, allImportant ? 'unimportant' : 'important') },
      { label: allStarred ? 'Remove star' : 'Add star', icon: allStarred ? 'star_border' : 'star', onClick: () => runAction(targets, allStarred ? 'unstar' : 'star') },
      { label: 'Report spam', icon: 'spam', onClick: () => runAction(targets, 'spam') },
      { label: 'Snooze', icon: 'schedule', more: true, onClick: () => showSnoozeMenu(at, targets) },
      { sep: true },
      ...(oneAccount ? [
        { label: 'Move to', icon: 'move_to', more: true, onClick: () => showMoveMenu(at, targets) },
        { label: 'Label as', icon: 'label', more: true, onClick: () => showLabelMenu(at, targets) }
      ] : []),
      ...(single?.unsubscribe ? [{ label: 'Unsubscribe', icon: 'close', onClick: () => unsubscribe(single) }] : []),
      ...(sender ? [
        { sep: true },
        { label: `Find emails from ${sender.isMe ? 'me' : firstName(sender.name || sender.email)}`, icon: 'search', onClick: () => runSearch(`from:${sender.email}`) }
      ] : []),
      { sep: true },
      { label: single ? 'Open in Gmail' : `Open ${targets.length} in Gmail`, icon: 'open_in_new', onClick: openGmail }
    ]
  });
}

// Prints from a sandboxed iframe: the email HTML is untrusted, so it never gets script access
function printThread() {
  const email = readingEmail();
  const messages = state.thread?.messages || [];
  if (!email || !messages.length) return;
  const acc = accountOf(email);
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px;color-scheme:light;';
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(email.subject)}</title>
    <style>body{font:14px/1.5 Arial,sans-serif;margin:24px;color:#222}h1{font-size:20px;font-weight:400;margin:0 0 4px}
    .acc{color:#555;font-size:12px;margin-bottom:16px}.m{border-top:1px solid #ccc;padding:12px 0}.h{color:#555;font-size:12px;margin-bottom:8px}</style></head><body>
    <h1>${esc(email.subject)}</h1><div class="acc">${esc(acc.name)} &lt;${esc(acc.email)}&gt;</div>
    ${messages.map(m => `<div class="m"><div class="h"><b>${esc(m.from.name || m.from.email)}</b> &lt;${esc(m.from.email)}&gt; — ${esc(fullDate(m.date))}<br>To: ${esc(m.to)}</div>
      ${m.html || `<pre style="white-space:pre-wrap;font:inherit">${esc(m.text)}</pre>`}</div>`).join('')}
    </body></html>`;
  frame.addEventListener('load', () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  }, { once: true });
  document.body.appendChild(frame);
}

// ─── Label management (create / rename / colour / delete) ────────
// Gmail only accepts label colours from its own palette (background → text colour)
const LABEL_COLORS = {
  '#fb4c2f': '#ffffff', '#ffad47': '#ffffff', '#fad165': '#000000', '#16a766': '#ffffff',
  '#43d692': '#ffffff', '#4a86e8': '#ffffff', '#a479e2': '#ffffff', '#f691b3': '#ffffff',
  '#cccccc': '#000000', '#666666': '#ffffff', '#c9daf8': '#000000', '#b9e4d0': '#000000'
};
let labelManagerFor = null;

async function createLabelPrompt(acc) {
  const name = await dialog({
    title: 'New label',
    body: `In <b>${esc(acc.name)}</b> (${esc(acc.email)}). Use “Parent/Child” to nest it under another label.`,
    input: '',
    confirm: 'Create'
  });
  if (!name || !name.trim()) return null;
  const res = await send({ type: 'LABEL_CREATE', accountId: acc.id, name: name.trim() });
  if (!res.success) { toast(`Couldn't create the label: ${res.error}`); return null; }
  toast(`Label "${res.label.name}" created.`);
  return res.label;
}

function openLabelManager(accountId) {
  labelManagerFor = accountId;
  renderLabelManager();
}

function renderLabelManager() {
  const acc = getAccount(labelManagerFor);
  const root = overlay();
  const scrim = root.getElementById('dialog');
  if (!acc) { labelManagerFor = null; scrim.hidden = true; return; }
  const labels = acc.labels || [];
  scrim.innerHTML = `
    <div class="dialog lm" role="dialog" aria-modal="true">
      <h2>Labels</h2>
      <div class="lm-acc"><span class="lm-dot" style="background:${acc.color}"></span>${esc(acc.name)} · ${esc(acc.email)}</div>
      <div class="lm-list">
        ${labels.length ? labels.map(l => `
          <div class="lm-row" data-id="${esc(l.id)}">
            <span class="lm-sw" style="background:${esc(l.color || '#dde3ea')}"></span>
            <span class="lm-name">${esc(l.name)}</span>
            <button class="lm-btn" data-lm="color" title="Label colour">${icon('palette', 18)}</button>
            <button class="lm-btn" data-lm="rename" title="Rename">${icon('edit', 18)}</button>
            <button class="lm-btn danger" data-lm="delete" title="Remove label">${icon('delete', 18)}</button>
          </div>`).join('') : '<div class="lm-empty">This account has no labels yet.</div>'}
      </div>
      <div class="d-actions">
        <button class="d-btn" data-lm="create">${icon('add', 18)} Create new label</button>
        <span style="flex:1"></span>
        <button class="d-btn" data-lm="close">Done</button>
      </div>
    </div>`;
  scrim.hidden = false;
  scrim.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') closeLabelManager(); };
  scrim.onclick = async (e) => {
    if (e.target === scrim) { closeLabelManager(); return; }
    const btn = e.target.closest('[data-lm]');
    if (!btn) return;
    const label = labels.find(l => l.id === btn.closest('[data-id]')?.dataset.id);
    switch (btn.dataset.lm) {
      case 'close': closeLabelManager(); break;
      case 'create': {
        labelManagerFor = null;
        await createLabelPrompt(acc);
        openLabelManager(acc.id);
        break;
      }
      case 'rename': {
        labelManagerFor = null;
        const name = await dialog({ title: 'Edit label', body: `Rename “${esc(label.name)}”.`, input: label.name, confirm: 'Save' });
        if (name && name.trim() && name.trim() !== label.name) {
          const res = await send({ type: 'LABEL_UPDATE', accountId: acc.id, labelId: label.id, name: name.trim() });
          toast(res.success ? 'Label renamed.' : `Couldn't rename: ${res.error}`);
        }
        openLabelManager(acc.id);
        break;
      }
      case 'delete': {
        labelManagerFor = null;
        const ok = await dialog({
          title: 'Remove label?',
          body: `Remove the label “${esc(label.name)}”? Conversations keep everything else; they just lose this label.`,
          confirm: 'Remove'
        });
        if (ok) {
          const res = await send({ type: 'LABEL_DELETE', accountId: acc.id, labelId: label.id });
          toast(res.success ? `Label "${label.name}" removed.` : `Couldn't remove: ${res.error}`);
        }
        openLabelManager(acc.id);
        break;
      }
      case 'color':
        showMenu(btn, {
          title: 'Label colour',
          items: [
            ...Object.keys(LABEL_COLORS).map(c => ({
              label: c === label.color ? '✓ Selected' : ' ',
              dot: c,
              onClick: async () => {
                const res = await send({ type: 'LABEL_UPDATE', accountId: acc.id, labelId: label.id, color: c });
                if (!res.success) toast(`Couldn't change the colour: ${res.error}`);
              }
            })),
            { sep: true },
            { label: 'Remove colour', onClick: async () => {
              const res = await send({ type: 'LABEL_UPDATE', accountId: acc.id, labelId: label.id, color: null });
              if (!res.success) toast(`Couldn't change the colour: ${res.error}`);
            } }
          ]
        });
        break;
    }
  };
}

function closeLabelManager() {
  labelManagerFor = null;
  const scrim = hosts.overlay?.getElementById('dialog');
  if (scrim) { scrim.hidden = true; scrim.innerHTML = ''; }
}

// ─── Verification / promo code detection ─────────────────────────
const OTP_WORDS = /\b(code|codes|c[oó]digo|otp|one[- ]?time|verification|verify|verifica[cç][aã]o|verificar|confirm|confirmation|confirma[cç][aã]o|security|seguran[cç]a|log ?in|sign[- ]?in|iniciar sess[aã]o|passcode|pin|2fa|two[- ]?factor|token|autentica[cç][aã]o|authentication)\b/gi;
const PROMO_WORDS = /\b(promo|coupon|cup[aã]o|discount|desconto|off|voucher|vale)\b/i;

function detectCode(subject, body) {
  const text = `${subject || ''}\n${body || ''}`.replace(/[ \t ]+/g, ' ').slice(0, 6000);
  const keywords = [...text.matchAll(OTP_WORDS)].map(m => m.index);
  if (!keywords.length) return null;

  const candidates = [];
  const add = (raw, index, penalty) => {
    const value = raw.replace(/[\s-]/g, '');
    if (/^(19|20)\d{2}$/.test(value)) return;                 // years
    if (/^0+$/.test(value) || /^(\d)\1+$/.test(value)) return; // 0000, 1111
    const dist = Math.min(...keywords.map(k => Math.abs(k - index)));
    if (dist > 160) return;
    candidates.push({ display: raw.trim(), value, score: dist + penalty + (index > (subject || '').length ? 10 : 0) });
  };

  // "code is 123456", "código: AB12CD"
  for (const m of text.matchAll(/\b(?:code|c[oó]digo|otp|pin|passcode|token)\b(?:\s+(?:is|é|e|was))?\s*[:：]?\s*([A-Z0-9]{4,10}|\d{3}[ -]\d{3})\b/gi)) {
    if (/\d/.test(m[1])) add(m[1], m.index, -50);
  }
  // Google style "G-123456"
  for (const m of text.matchAll(/\bG-(\d{6})\b/g)) add(m[1], m.index, -40);
  // bare digit codes: 4–8 digits or "123 456"; not part of prices, dates, times, phones, urls
  for (const m of text.matchAll(/(?<![\w@/.:$€£#+,-])(\d{3}[ -]\d{3}|\d{4,8})(?![\w%@€$]|[.,:/]\d)/g)) add(m[1], m.index, 0);
  // mixed letters+digits in capitals: "AB12CD", "X7Q-9KM"
  for (const m of text.matchAll(/(?<![\w@/.:#-])((?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{3,5}-?[A-Z0-9]{2,6})(?![\w@])/g)) add(m[1], m.index, 30);

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  const promo = PROMO_WORDS.test(text) && !/verif|one[- ]?time|log ?in|sign[- ]?in|iniciar|2fa|passcode|autentica|security|seguran/i.test(text);
  return { display: best.display, value: best.value, kind: promo ? 'promo' : 'otp' };
}

const CODE_MAX_AGE = 24 * 60 * 60 * 1000;
const codeCache = new Map();

// Rows only offer recent one-time codes (they expire); cached per thread version.
// The snippet often skips the code (e.g. it starts after a preheader), so when the
// email looks like a code email we read the message text in the background.
const codeFetching = new Set();

function rowCode(email) {
  if (!email.internalDate || Date.now() - email.internalDate > CODE_MAX_AGE) return null;
  const key = `${email.key}:${email.historyId}`;
  if (!codeCache.has(key)) {
    const fromSnippet = detectCode(email.subject, decodeEntities(email.snippet));
    if (fromSnippet || !looksLikeCodeEmail(email)) codeCache.set(key, fromSnippet);
    else { fetchRowCode(email, key); return null; }
  }
  const code = codeCache.get(key);
  return code?.kind === 'otp' ? code : null;
}

function looksLikeCodeEmail(email) {
  const text = `${email.subject} ${decodeEntities(email.snippet)}`;
  return /\b(code|c[oó]digo|otp|one[- ]?time|verif|passcode|pin|2fa|log ?in|sign[- ]?in|iniciar sess|autentica|security code|token)/i.test(text);
}

async function fetchRowCode(email, key) {
  if (codeFetching.has(key)) return;
  codeFetching.add(key);
  const res = await send({ type: 'GET_THREAD_TEXT', accountId: email.accountId, threadId: email.id });
  codeFetching.delete(key);
  codeCache.set(key, res.success ? detectCode(email.subject, res.text) : null);
  if (codeCache.get(key)) scheduleRender();
}

function messagePlainText(m) {
  if (m.text) return m.text;
  const doc = new DOMParser().parseFromString(m.html || '', 'text/html');
  doc.querySelectorAll('style, script, head, title').forEach(el => el.remove());
  return doc.body?.textContent || '';
}

function renderCodeCard() {
  const box = hosts.view?.getElementById('r-code');
  if (!box) return;
  const messages = state.thread?.messages || [];
  let found = null;
  for (let i = messages.length - 1; i >= 0 && !found; i--) {
    found = detectCode(messages[i].subject, messagePlainText(messages[i]));
  }
  if (!found) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="code-card">
      <div class="cc-title">${found.kind === 'promo' ? 'Promo code' : 'Requested code'}</div>
      <div class="cc-chars" aria-label="${esc(found.display)}">${[...found.display].map(ch => ch === ' ' || ch === '-'
        ? '<span class="cc-gap"></span>'
        : `<span class="cc-ch">${esc(ch)}</span>`).join('')}</div>
      <button class="cc-copy" data-act="copy-code" data-code="${esc(found.value)}">${icon('content_copy', 18)}<span>Copy code</span></button>
    </div>
    <div class="cc-note">Based on this email</div>`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // Fallback when the Clipboard API is blocked
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

async function copyCode(btn) {
  const code = btn.dataset.code;
  if (!code) return;
  if (!(await copyText(code))) { toast("Couldn't copy the code."); return; }
  toast(`Code ${code} copied.`);
  const label = btn.querySelector('span');
  if (label && btn.classList.contains('code-chip')) {
    btn.classList.add('done');
    setTimeout(() => btn.classList.remove('done'), 2000);
  } else if (label) {
    const old = label.textContent;
    label.textContent = 'Copied';
    btn.classList.add('done');
    setTimeout(() => { label.textContent = old; btn.classList.remove('done'); }, 2000);
  }
}

// ─── Compose / reply / forward ───────────────────────────────────
let composer = null;
const MAX_ATTACH_BYTES = 24 * 1024 * 1024;

// Splits on commas/semicolons outside quotes and angle brackets, then reads each address
function parseAddressList(raw) {
  const parts = [];
  let current = '';
  let quoted = false;
  let angled = false;
  for (const ch of String(raw || '')) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angled = true;
    else if (ch === '>' && !quoted) angled = false;
    if ((ch === ',' || ch === ';') && !quoted && !angled) { parts.push(current); current = ''; }
    else current += ch;
  }
  parts.push(current);

  return parts.map(part => {
    const p = part.trim();
    const angle = p.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
    if (angle) return { name: angle[1].trim().replace(/^"|"$/g, '').trim(), email: angle[2].toLowerCase() };
    const bare = p.match(/^"?([^\s"<>]+@[^\s"<>]+?)"?$/);
    return bare ? { name: '', email: bare[1].toLowerCase() } : null;
  }).filter(Boolean);
}
const fmtAddress = (a) => !a.name ? a.email : /[,;"<>]/.test(a.name) ? `"${a.name.replace(/"/g, '')}" <${a.email}>` : `${a.name} <${a.email}>`;

function bodyOnly(html) {
  return new DOMParser().parseFromString(html || '', 'text/html').body.innerHTML;
}

function quoteHeader(m) {
  const when = new Date(m.date).toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const who = `${m.from.name ? `${esc(m.from.name)} ` : ''}&lt;<a href="mailto:${esc(m.from.email)}">${esc(m.from.email)}</a>&gt;`;
  return { when, who };
}

function buildQuote(mode, m) {
  const { when, who } = quoteHeader(m);
  const original = m.html ? bodyOnly(m.html) : `<div style="white-space:pre-wrap">${esc(m.text || '')}</div>`;
  const textOriginal = (m.text || new DOMParser().parseFromString(m.html || '', 'text/html').body.innerText || '').trim();
  if (mode === 'forward') {
    return {
      html: `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: ${who}<br>Date: ${esc(when)}<br>Subject: ${esc(m.subject)}<br>To: ${esc(m.to)}<br>${m.cc ? `Cc: ${esc(m.cc)}<br>` : ''}</div><br><br>${original}</div>`,
      text: `---------- Forwarded message ---------\nFrom: ${m.from.name || ''} <${m.from.email}>\nDate: ${when}\nSubject: ${m.subject}\nTo: ${m.to}\n\n${textOriginal}`
    };
  }
  return {
    html: `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On ${esc(when)}, ${who} wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${original}</blockquote></div>`,
    text: `On ${when}, ${m.from.name || ''} <${m.from.email}> wrote:\n${textOriginal.split('\n').map(l => `> ${l}`).join('\n')}`
  };
}

function knownContacts() {
  const seen = new Map();
  for (const e of state.rawEmails) {
    for (const s of e.senders || []) if (s.email && !s.isMe && !seen.has(s.email)) seen.set(s.email, s.name);
    if (seen.size > 400) break;
  }
  return [...seen].map(([email, name]) => name && name !== email ? `${name} <${email}>` : email);
}

function composerEl() {
  if (!composer) return null;
  return composer.inline ? hosts.view?.getElementById('r-composer') : overlay().getElementById('compose');
}

function composerHtml(c) {
  const acc = getAccount(c.accountId) || state.accounts[0];
  const modeIcon = c.mode === 'forward' ? 'forward' : c.mode === 'replyAll' ? 'reply_all' : 'reply';
  const showCc = c.showCc || c.cc || c.bcc;
  const fields = `
    ${c.inline ? '' : `
      <div class="cmp-row"><span class="lbl">From</span>
        <span class="cmp-dot" id="cmp-from-dot" style="background:${acc?.color || '#444746'}"></span>
        <select id="cmp-from">${state.accounts.map(a => `<option value="${esc(a.id)}"${a.id === c.accountId ? ' selected' : ''}>${esc(a.name)} &lt;${esc(a.email)}&gt;</option>`).join('')}</select>
      </div>`}
    <div class="cmp-row">
      ${c.inline ? `<span class="cmp-mode" title="${esc(acc?.email || '')}">${icon(modeIcon)}</span><span class="cmp-dot" style="background:${acc?.color}" title="From ${esc(acc?.email || '')}"></span>` : ''}
      <span class="lbl">To</span>
      <input id="cmp-to" list="cmp-contacts" value="${esc(c.to || '')}" autocomplete="off" spellcheck="false">
      ${showCc ? '' : '<button class="cc-link" data-act="cmp-show-cc">Cc Bcc</button>'}
    </div>
    <div class="cmp-row"${showCc ? '' : ' hidden'} id="cmp-cc-row"><span class="lbl">Cc</span><input id="cmp-cc" list="cmp-contacts" value="${esc(c.cc || '')}" autocomplete="off"></div>
    <div class="cmp-row"${showCc ? '' : ' hidden'} id="cmp-bcc-row"><span class="lbl">Bcc</span><input id="cmp-bcc" list="cmp-contacts" value="${esc(c.bcc || '')}" autocomplete="off"></div>
    ${c.inline ? '' : `<div class="cmp-row"><input id="cmp-subject" placeholder="Subject" value="${esc(c.subject || '')}"></div>`}
    <div class="cmp-body" id="cmp-body" contenteditable="true" data-placeholder="${c.inline ? '' : 'Message'}"></div>
    ${c.quote ? '<div class="cmp-trim" title="The original message is included">•••</div>' : ''}
    <div class="cmp-atts" id="cmp-atts"></div>
    <div class="cmp-foot">
      <span class="send-group">
        <button class="btn-send" data-act="cmp-send" title="Send (Ctrl+Enter)">Send</button>
        <button class="btn-send-more" data-act="cmp-schedule" title="More send options">${icon('arrow_drop_down')}</button>
      </span>
      <button class="ib" data-act="cmp-bold" title="Bold">${icon('format_bold')}</button>
      <button class="ib" data-act="cmp-italic" title="Italic">${icon('format_italic')}</button>
      <button class="ib" data-act="cmp-underline" title="Underline">${icon('format_underlined')}</button>
      <button class="ib" data-act="cmp-list" title="Bulleted list">${icon('format_list')}</button>
      <button class="ib" data-act="cmp-link" title="Insert link">${icon('link')}</button>
      <span class="fsep"></span>
      <button class="ib" data-act="cmp-attach" title="Attach files">${icon('attach')}</button>
      <button class="ib" data-act="cmp-templates" title="Templates">${icon('snippet')}</button>
      <button class="cmp-remind${c.followupDays ? ' on' : ''}" data-act="cmp-followup" title="Remind me if nobody replies">${icon('bell', 18)}<span>${c.followupDays ? `${c.followupDays}d` : ''}</span></button>
      <span class="spacer"></span>
      <button class="ib" data-act="cmp-discard" title="Discard">${icon('delete')}</button>
    </div>
    <input type="file" id="cmp-file" multiple hidden>
    <datalist id="cmp-contacts">${knownContacts().map(x => `<option value="${esc(x)}">`).join('')}</datalist>`;

  if (c.inline) return `<div class="cmp inline">${fields}</div>`;
  return `
    <div class="cmp floating${c.minimized ? ' min' : ''}">
      <div class="cmp-head" data-act="cmp-toggle-min">
        <span class="t" id="cmp-title">${esc(c.subject || 'New Message')}</span>
        <button class="hb" data-act="cmp-toggle-min" title="Minimise">${icon('minimize')}</button>
        <button class="hb" data-act="cmp-close" title="Save & close">${icon('close')}</button>
      </div>
      <div class="cmp-main">${fields}</div>
    </div>`;
}

function mountComposer() {
  const el = composerEl();
  if (!el) return;
  el.innerHTML = composerHtml(composer);
  if (composer.inline) hosts.view.getElementById('r-reply').hidden = true;
  else el.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act) { e.stopPropagation(); onComposerAction(act, e.target.closest('[data-act]')); }
  };

  const body = el.querySelector('#cmp-body');
  body.innerHTML = composer.bodyHtml || '<div><br></div>';
  body.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendComposer(); }
  });
  el.querySelectorAll('input').forEach(input => input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendComposer(); }
  }));
  el.querySelector('#cmp-subject')?.addEventListener('input', (e) => {
    const t = el.querySelector('#cmp-title');
    if (t) t.textContent = e.target.value || 'New Message';
  });
  el.querySelector('#cmp-from')?.addEventListener('change', (e) => {
    composer.accountId = e.target.value;
    el.querySelector('#cmp-from-dot').style.background = getAccount(composer.accountId)?.color || '#444746';
    applySignature();
  });
  el.querySelector('#cmp-file').addEventListener('change', (e) => addComposerFiles(e.target.files));
  renderComposerAttachments();
  applySignature();

  const focusTarget = composer.mode === 'forward' || composer.mode === 'new' ? el.querySelector('#cmp-to') : body;
  setTimeout(() => {
    focusTarget?.focus();
    if (composer.inline) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, 0);
}

// Parses HTML in an inert document and drops anything that could run code
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, link, meta, base, form, input, button, textarea, select').forEach(el => el.remove());
  doc.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.replace(/[\s\u0000-\u001f]/g, '').toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction' ||
          (/^(href|src|xlink:href|action|background|poster)$/.test(name) && /^(javascript|vbscript|data:text\/html)/.test(value))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}

// Gmail's signature for the "From" account, kept in its own block so switching accounts swaps it
async function applySignature() {
  const c = composer;
  if (!c) return;
  const res = await send({ type: 'GET_SEND_AS', accountId: c.accountId });
  if (composer !== c) return;
  const body = composerEl()?.querySelector('#cmp-body');
  if (!body) return;
  body.querySelector('.gmail_signature_wrap')?.remove();
  const signature = res.success && res.sendAs?.signature;
  if (signature) {
    const wrap = document.createElement('div');
    wrap.className = 'gmail_signature_wrap';
    // Signature HTML comes from the user's Gmail settings; sanitised anyway before it touches the DOM
    wrap.innerHTML = `<br><div class="gmail_signature" data-smartmail="gmail_signature">-- <br>${sanitizeHtml(signature)}</div>`;
    body.appendChild(wrap);
  }
}

function renderComposerAttachments() {
  const box = composerEl()?.querySelector('#cmp-atts');
  if (!box) return;
  const all = [
    ...composer.attachments.map((a, i) => ({ ...a, kind: 'new', i })),
    ...composer.forwardAttachments.map((a, i) => ({ ...a, kind: 'fwd', i }))
  ];
  box.innerHTML = all.map(a => `
    <span class="cmp-att" title="${esc(a.filename)}">
      <span class="n">${esc(a.filename)}</span><span class="z">(${esc(fmtSize(a.size))})</span>
      <button class="x" data-act="cmp-remove-att" data-kind="${a.kind}" data-i="${a.i}" title="Remove">${icon('close', 16)}</button>
    </span>`).join('');
}

async function addComposerFiles(files) {
  const total = () => [...composer.attachments, ...composer.forwardAttachments].reduce((n, a) => n + (a.size || 0), 0);
  for (const file of files) {
    if (total() + file.size > MAX_ATTACH_BYTES) {
      toast('Attachments are limited to 25 MB per message.');
      break;
    }
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    composer.attachments.push({ filename: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, data });
  }
  renderComposerAttachments();
}

function openCompose({ to = '', subject = '', accountId } = {}) {
  if (!state.accounts.length) { addAccount(); return; }
  if (composer && !composerIsEmpty() && !confirm('Discard the message you are writing?')) return;
  closeComposer();
  const defaultAcc = accountId || (state.filter !== 'all' && getAccount(state.filter) ? state.filter : state.accounts[0].id);
  composer = { mode: 'new', inline: false, accountId: defaultAcc, to, cc: '', bcc: '', subject, attachments: [], forwardAttachments: [] };
  mountComposer();
}

function openReply(mode, messageId) {
  const email = readingEmail();
  const messages = state.thread?.messages;
  if (!email || !messages?.length) return;
  const acc = accountOf(email);
  const me = acc.email.toLowerCase();
  const m = messages.find(x => x.id === messageId) || messages[messages.length - 1];

  if (composer && !composerIsEmpty() && !confirm('Discard the message you are writing?')) return;
  closeComposer();

  let to = '';
  let cc = '';
  if (mode !== 'forward') {
    const fromMe = m.from.email === me;
    const primary = fromMe ? parseAddressList(m.to) : parseAddressList(m.replyTo || `${m.from.name} <${m.from.email}>`);
    to = primary.filter(a => a.email !== me).map(fmtAddress).join(', ') || primary.map(fmtAddress).join(', ');
    if (mode === 'replyAll') {
      const toSet = new Set(primary.map(a => a.email));
      cc = parseAddressList(`${fromMe ? '' : m.to},${m.cc}`)
        .filter((a, i, arr) => a.email !== me && !toSet.has(a.email) && arr.findIndex(b => b.email === a.email) === i)
        .map(fmtAddress).join(', ');
    }
  }

  const baseSubject = (m.subject || email.subject || '').replace(/^\s*((re|fw|fwd|enc|res):\s*)+/i, '');
  composer = {
    mode,
    inline: true,
    accountId: email.accountId,
    threadKey: email.key,
    threadId: email.id,
    to,
    cc,
    bcc: '',
    subject: `${mode === 'forward' ? 'Fwd' : 'Re'}: ${baseSubject}`,
    inReplyTo: mode === 'forward' ? '' : m.messageId,
    references: mode === 'forward' ? '' : [m.references, m.messageId].filter(Boolean).join(' '),
    quote: buildQuote(mode, m),
    attachments: [],
    forwardAttachments: mode === 'forward'
      ? (m.attachments || []).map(a => ({ filename: a.filename, mimeType: a.mimeType, size: a.size, messageId: m.id, attachmentId: a.attachmentId }))
      : []
  };
  mountComposer();
}

function composerIsEmpty() {
  const el = composerEl();
  if (!composer || !el) return true;
  const body = el.querySelector('#cmp-body')?.cloneNode(true);
  body?.querySelector('.gmail_signature_wrap')?.remove();
  return !(body?.innerText || '').trim() && !composer.attachments.length &&
    (composer.inline || !(el.querySelector('#cmp-to')?.value || '').trim());
}

function closeComposer() {
  if (!composer) return;
  const el = composerEl();
  if (el) el.innerHTML = '';
  if (composer.inline && hosts.view) hosts.view.getElementById('r-reply').hidden = false;
  composer = null;
}

// mode: 'send' | 'draft' (save to Gmail Drafts) | 'schedule' (draft opened in Gmail to use its Schedule send)
async function sendComposer({ mode = 'send' } = {}) {
  const c = composer;
  const el = composerEl();
  if (!c || !el || c.sending) return;
  const to = el.querySelector('#cmp-to').value.trim();
  const cc = el.querySelector('#cmp-cc').value.trim();
  const bcc = el.querySelector('#cmp-bcc').value.trim();
  if (mode !== 'draft') {
    if (!to && !cc && !bcc) { toast('Please specify at least one recipient.'); el.querySelector('#cmp-to').focus(); return; }
    if (parseAddressList([to, cc, bcc].join(',')).length === 0) { toast('Please check the recipient addresses.'); return; }
  }

  const body = el.querySelector('#cmp-body');
  const subject = c.inline ? c.subject : el.querySelector('#cmp-subject').value.trim();
  if (mode === 'send' && !c.inline && !subject && !confirm('Send this message without a subject?')) return;

  const html = `<div dir="ltr">${body.innerHTML}</div>${c.quote ? `<br>${c.quote.html}` : ''}`;
  const text = `${body.innerText.trim()}${c.quote ? `\n\n${c.quote.text}` : ''}`;
  c.sending = true;
  el.querySelector('.btn-send').disabled = true;
  toast(mode === 'send' ? 'Sending…' : 'Saving draft…');

  const payload = {
    accountId: c.accountId,
    to, cc, bcc, subject, html, text,
    threadId: c.threadId,
    inReplyTo: c.inReplyTo,
    references: c.references,
    attachments: c.attachments.map(({ filename, mimeType, data }) => ({ filename, mimeType, data })),
    forwardAttachments: c.forwardAttachments,
    followupDays: c.followupDays || 0
  };
  const res = mode === 'send'
    ? await send({ type: 'SEND_MESSAGE', ...payload })
    : await send({ type: 'CREATE_DRAFT', payload });

  c.sending = false;
  if (!res.success) {
    el.querySelector('.btn-send').disabled = false;
    toast(`Couldn't ${mode === 'send' ? 'send' : 'save the draft'}: ${res.error}`);
    return;
  }
  if (composer === c) closeComposer();
  if (mode !== 'send') {
    const draftUrl = `https://mail.google.com/mail/?authuser=${encodeURIComponent(res.draft.email)}#drafts?compose=${res.draft.messageId}`;
    if (mode === 'schedule') {
      window.open(draftUrl, '_blank');
      toast(`Opened in Gmail (${res.draft.email}). Use ▾ next to Send → Schedule send — Gmail sends it even if your computer is off.`, { duration: 12000 });
    } else {
      toast(`Draft saved to Gmail (${res.draft.email}).`, { action: 'Open', onAction: () => window.open(draftUrl, '_blank') });
    }
    return;
  }
  toast(c.followupDays ? `Message sent. You'll be reminded in ${c.followupDays} day${c.followupDays === 1 ? '' : 's'} if nobody replies.` : 'Message sent.');
  // Show the new message in the open conversation
  if (c.threadKey && state.readingKey === c.threadKey) {
    const reply = await send({ type: 'GET_THREAD', accountId: c.accountId, threadId: c.threadId });
    if (reply.success && state.readingKey === c.threadKey) {
      state.thread.messages = reply.thread.messages;
      renderMessages();
    }
  }
}

function onComposerAction(act, el) {
  const root = composerEl();
  if (!composer || !root) return;
  const body = root.querySelector('#cmp-body');
  const format = (cmd, value) => { body.focus(); document.execCommand(cmd, false, value); };
  switch (act) {
    case 'cmp-send': sendComposer(); break;
    case 'cmp-schedule':
      showMenu(el, {
        items: [
          { label: 'Schedule send in Gmail…', icon: 'schedule', onClick: () => sendComposer({ mode: 'schedule' }) },
          { label: 'Save as draft', icon: 'drafts', onClick: () => sendComposer({ mode: 'draft' }) }
        ]
      });
      break;
    case 'cmp-followup':
      showMenu(el, {
        title: 'Remind me if nobody replies in',
        items: [
          ...[1, 3, 7].map(d => ({ label: `${composer.followupDays === d ? '✓ ' : ''}${d === 7 ? '1 week' : `${d} day${d === 1 ? '' : 's'}`}`, onClick: () => setComposerFollowup(d) })),
          { sep: true },
          { label: `${composer.followupDays ? '' : '✓ '}Don't remind me`, onClick: () => setComposerFollowup(0) }
        ]
      });
      break;
    case 'cmp-templates': showTemplatesMenu(el); break;
    case 'cmp-show-cc':
      root.querySelector('#cmp-cc-row').hidden = false;
      root.querySelector('#cmp-bcc-row').hidden = false;
      el.remove();
      root.querySelector('#cmp-cc').focus();
      break;
    case 'cmp-toggle-min':
      composer.minimized = !composer.minimized;
      root.querySelector('.cmp')?.classList.toggle('min', composer.minimized);
      break;
    case 'cmp-close':
      // No drafts yet: closing keeps nothing, so ask first when there's content
      if (composerIsEmpty() || confirm('Discard this message?')) closeComposer();
      break;
    case 'cmp-discard':
      closeComposer();
      toast('Draft discarded.');
      break;
    case 'cmp-attach': root.querySelector('#cmp-file').click(); break;
    case 'cmp-remove-att': {
      const list = el.dataset.kind === 'fwd' ? composer.forwardAttachments : composer.attachments;
      list.splice(Number(el.dataset.i), 1);
      renderComposerAttachments();
      break;
    }
    case 'cmp-bold': format('bold'); break;
    case 'cmp-italic': format('italic'); break;
    case 'cmp-underline': format('underline'); break;
    case 'cmp-list': format('insertUnorderedList'); break;
    case 'cmp-link': {
      const url = prompt('Link address (URL):', 'https://');
      if (url && /^(https?:|mailto:)/i.test(url)) format('createLink', url);
      break;
    }
  }
}

// ─── Time presets (snooze, schedule send) ────────────────────────
function atTime(daysFromNow, hour) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function nextWeekday(weekday, hour) { // 0 = Sunday … 6 = Saturday
  const d = new Date();
  const diff = ((weekday - d.getDay()) + 7) % 7 || 7;
  return atTime(diff, hour);
}

function fmtWhen(ts) {
  return new Date(ts).toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function snoozePresets() {
  const now = new Date();
  const laterToday = new Date(now.getTime() + 3 * 3600e3);
  laterToday.setMinutes(0, 0, 0);
  const day = now.getDay();
  return [
    ...(laterToday.getDate() === now.getDate() && laterToday.getHours() <= 21 ? [{ label: 'Later today', at: laterToday.getTime() }] : []),
    { label: 'Tomorrow', at: atTime(1, 8) },
    ...(day >= 1 && day <= 4 ? [{ label: 'This weekend', at: nextWeekday(6, 8) }] : []),
    { label: 'Next week', at: nextWeekday(1, 8) }
  ];
}

async function pickDateTime(title) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date(atTime(1, 8));
  const value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const picked = await dialog({ title, body: 'Pick a date and time.', input: value, inputType: 'datetime-local', confirm: 'Save' });
  if (!picked) return null;
  const at = new Date(picked).getTime();
  if (!(at > Date.now() + 30_000)) { toast('Please pick a time in the future.'); return null; }
  return at;
}

// ─── Snooze ──────────────────────────────────────────────────────
function showSnoozeMenu(anchor, emails, after) {
  emails = emails.filter(Boolean);
  if (!emails.length) return;
  showMenu(anchor, {
    title: 'Snooze until…',
    items: [
      ...snoozePresets().map(p => ({ label: `${p.label} · ${fmtWhen(p.at)}`, icon: 'schedule', onClick: () => doSnooze(emails, p.at, after) })),
      { sep: true },
      { label: 'Pick date & time…', icon: 'schedule', onClick: async () => { const at = await pickDateTime('Snooze until'); if (at) doSnooze(emails, at, after); } }
    ]
  });
}

async function doSnooze(emails, until, after) {
  const keys = emails.map(e => e.key);
  keys.forEach(k => { pending.set(k, { drop: true }); state.selected.delete(k); });
  rebuildEmails();
  scheduleRender();
  if (after) after();

  const res = await send({ type: 'SNOOZE', until, items: emails.map(e => ({ accountId: e.accountId, threadId: e.id })) });
  const done = new Set(res.success ? res.done : []);
  if (done.size) {
    state.rawEmails = state.rawEmails.filter(e => !done.has(e.key));
    state.searchResults = state.searchResults.filter(e => !done.has(e.key));
  }
  keys.forEach(k => pending.delete(k));
  rebuildEmails();
  scheduleRender();

  if (!res.success) { toast(`Couldn't snooze: ${res.error}`); return; }
  const n = res.done.length;
  toast(`${n === 1 ? 'Conversation' : `${n} conversations`} snoozed until ${fmtWhen(until)}.`, {
    action: 'Undo',
    onAction: async () => {
      for (const key of res.done) await send({ type: 'UNSNOOZE', key });
      toast('Snooze cancelled.');
    }
  });
}

// ─── Follow-up reminders ─────────────────────────────────────────
function setComposerFollowup(days) {
  if (!composer) return;
  composer.followupDays = days;
  const btn = composerEl()?.querySelector('.cmp-remind');
  if (btn) {
    btn.classList.toggle('on', !!days);
    btn.querySelector('span').textContent = days ? `${days}d` : '';
  }
}

async function remindIfNoReply(email, days) {
  const res = await send({ type: 'SET_FOLLOWUP', accountId: email.accountId, threadId: email.id, subject: email.subject, days });
  toast(res.success
    ? `You'll be reminded on ${fmtWhen(res.item.dueAt)} if nobody replies.`
    : `Couldn't set the reminder: ${res.error}`);
}

// ─── Templates (stored locally) ──────────────────────────────────
async function getTemplates() {
  const { templates = [] } = await chrome.storage.local.get('templates');
  return templates;
}

async function showTemplatesMenu(anchor) {
  const templates = await getTemplates();
  const root = composerEl();
  if (!composer || !root) return;
  showMenu(anchor, {
    title: 'Templates',
    empty: 'No templates yet.',
    items: [
      ...templates.map(t => ({ label: t.name, icon: 'snippet', onClick: () => insertTemplate(t) })),
      ...(templates.length ? [{ sep: true }] : []),
      { label: 'Save this message as a template…', icon: 'add', onClick: saveTemplate },
      ...(templates.length ? [{ label: 'Delete a template…', icon: 'delete', onClick: () => deleteTemplateMenu(anchor) }] : [])
    ]
  });
}

function insertTemplate(t) {
  const root = composerEl();
  if (!root) return;
  const body = root.querySelector('#cmp-body');
  body.focus();
  document.execCommand('insertHTML', false, sanitizeHtml(t.html));
  const subject = root.querySelector('#cmp-subject');
  if (subject && !subject.value.trim() && t.subject) {
    subject.value = t.subject;
    subject.dispatchEvent(new Event('input'));
  }
}

async function saveTemplate() {
  const root = composerEl();
  if (!root) return;
  const body = root.querySelector('#cmp-body').cloneNode(true);
  body.querySelector('.gmail_signature_wrap')?.remove();
  if (!body.innerText.trim()) { toast('Write something first, then save it as a template.'); return; }
  const subject = root.querySelector('#cmp-subject')?.value.trim() || '';
  const name = await dialog({ title: 'Save template', body: 'Name this template.', input: subject || 'My template', confirm: 'Save' });
  if (!name || !name.trim()) return;
  const templates = await getTemplates();
  templates.push({ id: crypto.randomUUID(), name: name.trim(), subject, html: body.innerHTML });
  templates.sort((a, b) => a.name.localeCompare(b.name));
  await chrome.storage.local.set({ templates });
  toast(`Template "${name.trim()}" saved.`);
}

async function deleteTemplateMenu(anchor) {
  const templates = await getTemplates();
  showMenu(anchor, {
    title: 'Delete template',
    items: templates.map(t => ({
      label: t.name,
      icon: 'delete',
      onClick: async () => {
        await chrome.storage.local.set({ templates: (await getTemplates()).filter(x => x.id !== t.id) });
        toast(`Template "${t.name}" deleted.`);
      }
    }))
  });
}

// ─── Planner: snoozed conversations and reminders ────────────────
let plannerOpen = false;

function applyItems(data) {
  if ('prefs' in data) state.prefs = data.prefs || {};
  for (const k of ['snoozes', 'followups']) if (k in data) state.items[k] = data[k] || [];
}

function plannerCount() {
  return state.items.snoozes.length + state.items.followups.length;
}

function openPlanner() {
  plannerOpen = true;
  renderPlanner();
}

function renderPlanner() {
  const root = overlay();
  const scrim = root.getElementById('dialog');
  const accLine = (id) => {
    const a = getAccount(id);
    return a ? `<span class="pl-dot" style="background:${a.color}"></span>${esc(a.name)}` : '';
  };
  const section = (title, list, kind, action, describe) => `
    <div class="pl-sec">${esc(title)} <span class="pl-n">${list.length}</span></div>
    ${list.length ? list.map(it => `
      <div class="pl-row" data-kind="${kind}" data-id="${esc(it.id)}">
        <div class="pl-main">
          <div class="pl-subj">${esc(it.subject || '(no subject)')}</div>
          <div class="pl-meta">${accLine(it.accountId)} · ${esc(describe(it))}</div>
        </div>
        <button class="d-btn" data-pl="cancel">${esc(action)}</button>
      </div>`).join('') : '<div class="pl-empty">Nothing here.</div>'}`;

  scrim.innerHTML = `
    <div class="dialog planner" role="dialog" aria-modal="true">
      <h2>Snoozed &amp; reminders</h2>
      <div class="pl-list">
        ${section('Snoozed', state.items.snoozes, 'snooze', 'Unsnooze', it => `back ${fmtWhen(it.dueAt)}`)}
        ${section('Reminders if no reply', state.items.followups, 'followup', 'Cancel', it => `check ${fmtWhen(it.dueAt)}`)}
      </div>
      <p class="pl-note">Snoozed conversations and reminders are handled by the extension: if Chrome is closed at that time, they happen as soon as it opens. Scheduled emails are handled by Gmail itself (see Drafts / Scheduled in Gmail).</p>
      <div class="d-actions"><button class="d-btn" data-pl="close">Done</button></div>
    </div>`;
  scrim.hidden = false;
  scrim.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') closePlanner(); };
  scrim.onclick = async (e) => {
    if (e.target === scrim) { closePlanner(); return; }
    const btn = e.target.closest('[data-pl]');
    if (!btn) return;
    if (btn.dataset.pl === 'close') { closePlanner(); return; }
    const row = btn.closest('.pl-row');
    btn.disabled = true;
    const res = await send({ type: 'CANCEL_ITEM', kind: row.dataset.kind, id: row.dataset.id });
    if (!res.success) { btn.disabled = false; toast(`Couldn't update: ${res.error}`); }
  };
}

function closePlanner() {
  plannerOpen = false;
  const scrim = hosts.overlay?.getElementById('dialog');
  if (scrim) { scrim.hidden = true; scrim.innerHTML = ''; }
}

// ─── Drag & drop to labels ───────────────────────────────────────
let dragState = null;

function onRowDragStart(e) {
  const row = e.target.closest?.('.row');
  const email = row && emailByKey(row.dataset.key);
  if (!email) return;

  // Dragging a selected row drags the whole selection (same account only — labels are per account)
  let emails = state.selected.has(email.key) ? selectedEmails() : [email];
  if (new Set(emails.map(x => x.accountId)).size > 1) emails = [email];
  dragState = { emails, accountId: email.accountId };

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', emails.map(x => x.subject).join('\n'));
  e.dataTransfer.setDragImage(dragGhost(emails.length), 16, 16);
  hideMenu();
  setTimeout(showDropPanel, 0);
}

function dragGhost(n) {
  let ghost = document.getElementById('ui-drag-ghost');
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.id = 'ui-drag-ghost';
    ghost.style.cssText = `position:fixed;top:-1000px;left:-1000px;padding:10px 16px;border-radius:8px;background:#0b57d0;color:#fff;font:500 14px ${FONT};box-shadow:0 2px 6px rgba(0,0,0,.3);white-space:nowrap;`;
    document.body.appendChild(ghost);
  }
  ghost.textContent = `Move ${n} conversation${n === 1 ? '' : 's'}`;
  return ghost;
}

function showDropPanel() {
  if (!dragState) return;
  const root = overlay();
  const panel = root.getElementById('drop-panel');
  const acc = getAccount(dragState.accountId);
  if (!acc) return;
  const n = dragState.emails.length;
  const labels = acc.labels || [];

  panel.innerHTML = `
    <div class="dp-head"><span class="dot" style="background:${acc.color}"></span>${esc(acc.name || acc.email)}</div>
    <div class="dp-sub">Drop to move ${n} conversation${n === 1 ? '' : 's'}</div>
    ${labels.length
      ? labels.map(l => `<div class="drop-item" data-drop="move" data-id="${esc(l.id)}" data-name="${esc(l.name)}">
          <svg viewBox="0 0 24 24" style="color:${esc(l.color || acc.color)}"><path d="${ICONS.label}"/></svg><span>${esc(l.name)}</span></div>`).join('')
      : '<div class="dp-empty">This account has no labels.</div>'}
    <div class="dp-sep"></div>
    <div class="drop-item" data-drop="archive">${icon('archive')}<span>Archive</span></div>
    <div class="drop-item" data-drop="spam">${icon('spam')}<span>Spam</span></div>
    <div class="drop-item" data-drop="trash">${icon('delete')}<span>Bin</span></div>`;

  // Sit on top of Gmail's navigation, where its own labels live
  const nav = document.querySelector('[role="navigation"]')?.getBoundingClientRect();
  const wide = nav && nav.width >= 180;
  const top = Math.max(wide ? nav.top + 8 : 80, 72);
  panel.style.left = `${wide ? nav.left + 4 : 16}px`;
  panel.style.top = `${top}px`;
  panel.style.width = `${wide ? Math.min(nav.width - 8, 300) : 260}px`;
  panel.style.maxHeight = `${innerHeight - top - 16}px`;
  panel.hidden = false;
}

function hideDropPanel() {
  dragState = null;
  if (hosts.overlay) hosts.overlay.getElementById('drop-panel').hidden = true;
}

function onDropPanelOver(e) {
  const item = e.target.closest?.('.drop-item');
  if (!item || !dragState) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  hosts.overlay.querySelectorAll('.drop-item.over').forEach(el => { if (el !== item) el.classList.remove('over'); });
  item.classList.add('over');
}

function onDropPanelDrop(e) {
  const item = e.target.closest?.('.drop-item');
  if (!item || !dragState) return;
  e.preventDefault();
  const { emails } = dragState;
  hideDropPanel();
  const action = item.dataset.drop;
  if (action === 'move') runAction(emails, 'move', { labelId: item.dataset.id, labelName: item.dataset.name });
  else runAction(emails, action);
}

// ─── Actions (optimistic + undo) ─────────────────────────────────
const DROP_ACTIONS = ['archive', 'trash', 'spam', 'move'];
const RESTORE_ACTIONS = ['unarchive', 'untrash', 'unspam'];
const PATCHES = {
  read: { unread: false }, unread: { unread: true },
  star: { starred: true }, unstar: { starred: false },
  important: { important: true }, unimportant: { important: false }
};
const UNDO = { archive: 'unarchive', trash: 'untrash', spam: 'unspam', move: 'unarchive' };

function actionMessage(action, n, labelName) {
  const c = n === 1 ? 'Conversation' : `${n} conversations`;
  switch (action) {
    case 'archive': return `${c} archived.`;
    case 'trash': return `${c} moved to Bin.`;
    case 'spam': return `${c} marked as spam.`;
    case 'read': return `${c} marked as read.`;
    case 'unread': return `${c} marked as unread.`;
    case 'move': return `${c} moved to "${labelName}".`;
    default: return null;
  }
}

async function runAction(emails, action, { labelId, labelName, quiet = false } = {}) {
  emails = emails.filter(Boolean);
  if (!emails.length) return false;
  const keys = emails.map(e => e.key);
  const drop = DROP_ACTIONS.includes(action);

  if (RESTORE_ACTIONS.includes(action)) {
    const present = new Set(state.rawEmails.map(e => e.key));
    state.rawEmails = [...state.rawEmails, ...emails.filter(e => !present.has(e.key))]
      .sort((a, b) => b.internalDate - a.internalDate);
  } else {
    keys.forEach(k => pending.set(k, drop ? { drop: true } : { patch: PATCHES[action] || {} }));
  }
  if (drop) keys.forEach(k => state.selected.delete(k));
  rebuildEmails();
  scheduleRender();

  const res = await send({
    type: 'THREAD_ACTION',
    action,
    labelId,
    items: emails.map(e => ({ accountId: e.accountId, threadId: e.id }))
  });

  // Make the confirmed result stick locally even if storage.onChanged arrives later
  const done = new Set(res.success ? res.done : []);
  if (done.size) {
    if (drop) state.rawEmails = state.rawEmails.filter(e => !done.has(e.key));
    else if (PATCHES[action]) state.rawEmails = state.rawEmails.map(e => done.has(e.key) ? { ...e, ...PATCHES[action] } : e);
  }
  if (done.size && state.searchQuery !== null) {
    if (drop) state.searchResults = state.searchResults.filter(e => !done.has(e.key));
    else if (PATCHES[action]) state.searchResults = state.searchResults.map(e => done.has(e.key) ? { ...e, ...PATCHES[action] } : e);
    else if (action === 'label' || action === 'unlabel') {
      state.searchResults = state.searchResults.map(e => !done.has(e.key) ? e : {
        ...e,
        labelIds: action === 'label' ? [...new Set([...(e.labelIds || []), labelId])] : (e.labelIds || []).filter(l => l !== labelId)
      });
    } else if (RESTORE_ACTIONS.includes(action)) {
      const present = new Set(state.searchResults.map(e => e.key));
      state.searchResults = [...state.searchResults, ...emails.filter(e => done.has(e.key) && !present.has(e.key))]
        .sort((a, b) => b.internalDate - a.internalDate);
    }
  }
  if (!res.success && RESTORE_ACTIONS.includes(action)) {
    state.rawEmails = state.rawEmails.filter(e => !keys.includes(e.key));
  }
  keys.forEach(k => pending.delete(k));
  rebuildEmails();
  scheduleRender();

  if (!res.success) {
    const acc = res.needsReauth ? getAccount(emails[0].accountId) : null;
    toast(`Couldn't complete the action: ${res.error}`, acc ? { action: 'Sign in', onAction: () => reauth(acc) } : {});
    return false;
  }

  if (res.failed?.length) {
    toast(`${res.done.length} of ${emails.length} conversations updated. Error: ${res.failed[0].error}`);
  } else if (!quiet) {
    const message = actionMessage(action, res.done.length, labelName);
    const undo = UNDO[action];
    const doneEmails = emails.filter(e => done.has(e.key));
    if (message) {
      toast(message, undo ? {
        action: 'Undo',
        onAction: async () => {
          if (await runAction(doneEmails, undo, { quiet: true })) toast('Action undone.');
        }
      } : {});
    }
  }
  return true;
}

async function unsubscribe(email) {
  const acc = accountOf(email);
  const sender = email.senders?.[0]?.name || email.senders?.[0]?.email || 'this sender';
  const ok = await dialog({
    title: `Unsubscribe from ${esc(sender)}?`,
    body: email.unsubscribe?.mailto
      ? "An unsubscribe email to the sender opens in this account's Gmail — just press Send."
      : "The sender's unsubscribe page opens in a new tab.",
    confirm: 'Unsubscribe'
  });
  if (!ok) return;

  const res = await send({ type: 'UNSUBSCRIBE', accountId: email.accountId, threadId: email.id });
  if (!res.success) { toast(`Couldn't unsubscribe: ${res.error}`); return; }
  if (res.method === 'url') {
    window.open(res.url, '_blank', 'noopener');
  } else if (res.mailto) {
    const m = res.mailto.match(/^mailto:([^?]+)(?:\?(.*))?$/i);
    const params = new URLSearchParams(m?.[2] || '');
    const url = `https://mail.google.com/mail/?authuser=${encodeURIComponent(acc.email)}&view=cm&fs=1` +
      `&to=${encodeURIComponent(decodeURIComponent(m?.[1] || ''))}&su=${encodeURIComponent(params.get('subject') || 'unsubscribe')}` +
      `&body=${encodeURIComponent(params.get('body') || '')}`;
    window.open(url, '_blank');
    toast('Send the email that opened in Gmail to finish.');
  }
}

// ─── Reader ──────────────────────────────────────────────────────
function readingEmail() {
  if (!state.readingKey) return null;
  return emailByKey(state.readingKey) || state.rawEmails.find(e => e.key === state.readingKey) || state.thread?.email || null;
}

function openReader(key) {
  const root = hosts.view;
  if (!root) return;
  if (state.readingKey === key && state.thread) { renderReaderChrome(); return; }

  const sep = key.indexOf(':');
  const accountId = key.slice(0, sep);
  const threadId = key.slice(sep + 1);
  const email = emailByKey(key) || state.rawEmails.find(e => e.key === key) ||
    { key, id: threadId, accountId, subject: '', senders: [], labelIds: [] };

  if (composer?.inline) closeComposer();
  state.readingKey = key;
  state.thread = { email, messages: null };
  clearAttachmentCache();
  hideMenu();

  root.getElementById('list-view').hidden = true;
  root.getElementById('reader-view').hidden = false;
  root.getElementById('reader-scroll').scrollTop = 0;
  root.getElementById('r-reply').hidden = true;
  root.getElementById('r-msgs').innerHTML = '<div class="loading"><span class="ring"></span>Loading conversation…</div>';
  root.getElementById('r-code').innerHTML = '';
  renderReaderChrome();

  if (email.unread) runAction([email], 'read', { quiet: true });

  send({ type: 'GET_THREAD', accountId, threadId }).then(res => {
    if (state.readingKey !== key) return;
    if (!res.success) {
      root.getElementById('r-msgs').innerHTML = `<div class="loading">${icon('warning')} Couldn't load the conversation: ${esc(res.error)}</div>`;
      return;
    }
    state.thread.messages = res.thread.messages;
    renderMessages();
  });
}

function closeReader() {
  if (!state.readingKey) {
    renderList();
    return;
  }
  const lastKey = state.readingKey;
  if (composer?.inline) closeComposer();
  state.readingKey = null;
  state.thread = null;
  renderList();
  // keep keyboard focus on the conversation we just left
  const { items } = pageEmails();
  const idx = items.findIndex(e => e.key === lastKey);
  if (idx >= 0) setFocus(idx);
}

function renderReaderChrome() {
  const root = hosts.view;
  const email = readingEmail();
  if (!root || !email) return;
  const acc = accountOf(email);
  const subject = email.subject || state.thread?.messages?.[0]?.subject || '(no subject)';
  const labels = (email.labelIds || []).map(id => (acc.labels || []).find(l => l.id === id)).filter(Boolean);
  const inInbox = 'inInbox' in email ? email.inInbox : state.emails.some(e => e.key === email.key);

  root.getElementById('r-subject-main').innerHTML = `
    <h2>${esc(subject)}</h2>
    <span class="r-chip acc no-x" style="background:${softColor(acc.color, 0.16)};color:${acc.color}" title="${esc(acc.email)}">
      <span class="dot" style="background:${acc.color}"></span>${esc(acc.name || acc.email)}
    </span>
    ${inInbox ? `<span class="r-chip">Inbox<span class="x" data-act="r-chip-inbox" title="Remove label Inbox (archive)">${icon('close')}</span></span>` : ''}
    ${email.category ? `<span class="r-chip no-x">${CATEGORY_NAMES[email.category]}</span>` : ''}
    ${labels.map(l => `<span class="r-chip"${l.color ? ` style="background:${esc(l.color)};color:${esc(l.textColor || '#1f1f1f')}"` : ''}>${esc(l.name)}<span class="x" data-act="r-chip-label" data-label="${esc(l.id)}" title="Remove label ${esc(l.name)}">${icon('close')}</span></span>`).join('')}
    <button class="r-imp${email.important ? ' on' : ''}" data-act="r-important" title="${email.important ? 'Important — click to mark as not important' : 'Not important — click to mark as important'}">${icon(email.important ? 'important' : 'important_border')}</button>`;

  const list = filteredEmails();
  const idx = list.findIndex(e => e.key === email.key);
  root.getElementById('r-pos').textContent = idx >= 0 ? `${(idx + 1).toLocaleString(LOCALE)} of ${list.length.toLocaleString(LOCALE)}` : '';
  root.getElementById('r-newer').disabled = idx <= 0;
  root.getElementById('r-older').disabled = idx < 0 || idx >= list.length - 1;

  root.querySelectorAll('.msg .star').forEach(btn => {
    btn.classList.toggle('on', !!email.starred);
    btn.innerHTML = icon(email.starred ? 'star' : 'star_border');
    btn.title = email.starred ? 'Starred' : 'Not starred';
  });
}

function stepReader(delta) {
  const list = filteredEmails();
  const idx = list.findIndex(e => e.key === state.readingKey);
  const next = list[idx + delta];
  if (idx >= 0 && next) navigate(state.filter, next.key);
}

async function readerAction(action) {
  const email = readingEmail();
  if (!email) return;
  const ok = await runAction([email], action);
  if (!ok) return;
  if (DROP_ACTIONS.includes(action) || action === 'unread') navigate(state.filter, null);
  else renderReaderChrome();
}

// "Name <email>" for every recipient, so the actual addresses are visible
function recipientsSummary(m, acc) {
  const people = parseAddressList([m.to, m.cc].filter(Boolean).join(', '))
    .filter((a, i, arr) => arr.findIndex(b => b.email === a.email) === i)
    .map(a => a.name && a.name.toLowerCase() !== a.email ? `${a.name} <${a.email}>` : a.email);
  return people.length ? people.join(', ') : acc.email;
}

function messageDetailsHtml(m) {
  const rows = [
    ['from:', m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email],
    m.replyTo && ['reply-to:', m.replyTo],
    ['to:', m.to],
    m.cc && ['cc:', m.cc],
    ['date:', fullDate(m.date)],
    ['subject:', m.subject]
  ].filter(Boolean);
  return `<table class="details">${rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
}

function renderMessages() {
  const root = hosts.view;
  const email = readingEmail();
  const messages = state.thread?.messages || [];
  const acc = accountOf(email);
  const container = root.getElementById('r-msgs');

  container.innerHTML = messages.map((m, i) => {
    const open = i === messages.length - 1 || m.unread;
    const name = m.from.name || m.from.email;
    const isMe = m.from.email === acc.email.toLowerCase();
    const showAddr = m.from.email && normalize(name) !== m.from.email;
    return `
      <div class="msg${open ? ' open' : ''}" data-mid="${esc(m.id)}">
        <div class="msg-head" data-act="toggle-msg">
          ${personAvatar(name, m.from.email, 40)}
          <div class="who">
            <div class="line1">
              <span class="name">${esc(isMe ? 'me' : name)}</span>
              ${showAddr ? `<span class="addr exp-only">&lt;${esc(m.from.email)}&gt;</span>` : ''}
              ${email.unsubscribe && !isMe ? '<span class="unsub-link exp-only" data-act="r-unsub">Unsubscribe</span>' : ''}
            </div>
            <div class="line2 to exp-only">to ${esc(recipientsSummary(m, acc))}<button class="det-btn" data-act="msg-details" title="Show details">${icon('arrow_drop_down', 18)}</button></div>
            <div class="det-box" hidden>${messageDetailsHtml(m)}</div>
            <div class="line2 col-only">${esc(decodeEntities(m.snippet))}</div>
          </div>
          <div class="meta">
            ${m.attachments?.length ? `<span class="col-only" style="display:flex;color:#444746;transform:rotate(45deg);margin-right:8px">${icon('attach', 16)}</span>` : ''}
            <span class="when" title="${esc(fullDate(m.date))}">${esc(open ? fullDate(m.date) : listDate(m.date))}</span>
            <button class="ib star exp-only" data-act="msg-star"></button>
            <button class="ib exp-only" data-act="msg-reply" title="Reply">${icon('reply')}</button>
            <button class="ib exp-only" data-act="msg-more" title="More">${icon('more_vert')}</button>
          </div>
        </div>
        <div class="msg-body exp-only"></div>
        ${m.attachments?.length ? `
          <div class="atts exp-only">
            <div class="atts-head">${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'}</div>
            ${m.attachments.map((a, idx) => `
              <div class="att" data-act="preview" data-mid="${esc(m.id)}" data-idx="${idx}" title="${esc(a.filename)} (${esc(fmtSize(a.size))})">
                <div class="att-thumb${isImage(a) ? ' img' : ''}" data-thumb="${esc(m.id)}:${idx}">${isImage(a) ? '' : `<span class="att-big" style="color:${attColor(a)}">${icon(attIcon(a), 40)}</span>`}</div>
                <div class="att-foot"><span class="att-ic" style="color:${attColor(a)}">${icon(attIcon(a), 16)}</span><span class="att-name">${esc(a.filename)}</span></div>
                <div class="att-hover">
                  <span class="att-hname">${esc(a.filename)}</span>
                  <button class="ib sm" data-act="download" data-mid="${esc(m.id)}" data-idx="${idx}" title="Download">${icon('download', 18)}</button>
                </div>
              </div>`).join('')}
          </div>` : ''}
      </div>`;
  }).join('');

  root.getElementById('r-reply').hidden = false;
  container.querySelectorAll('.msg.open').forEach(mountMessageBody);
  loadThumbnails(container);
  renderCodeCard();
  renderReaderChrome();
  if (state.pendingCompose) {
    const mode = state.pendingCompose;
    state.pendingCompose = null;
    openReply(mode);
  }
  const last = container.querySelector('.msg:last-child');
  if (messages.length > 2 && last) last.scrollIntoView({ block: 'start' });
}

const EMAIL_CSS = `
  :root{color-scheme:light only}
  html,body{margin:0;padding:0;background:#fff}
  body{font:14px/1.5 Arial,Helvetica,sans-serif;color:#222;word-wrap:break-word;overflow-x:auto;overflow-y:hidden}
  a{color:#1155cc}
  .hide-quotes .gmail_quote,.hide-quotes blockquote[type="cite"]{display:none!important}
`;

function linkify(escaped) {
  return escaped.replace(/\bhttps?:\/\/[^\s<>"']+/g, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

function fitIframe(iframe) {
  const doc = iframe.contentDocument;
  if (doc?.body) iframe.style.height = `${Math.ceil(doc.body.scrollHeight) + 4}px`;
}

function mountMessageBody(msgEl) {
  const body = msgEl.querySelector('.msg-body');
  if (!body || body.dataset.mounted) return;
  body.dataset.mounted = '1';
  const m = state.thread?.messages?.find(x => x.id === msgEl.dataset.mid);
  if (!m) return;

  if (!m.html) {
    body.innerHTML = `<div class="plain">${linkify(esc(m.text || decodeEntities(m.snippet)))}</div>`;
    return;
  }

  // No allow-scripts: the email can't run code. allow-same-origin lets us measure its height.
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  // An iframe's prefers-color-scheme follows the color-scheme of its <iframe> element
  iframe.style.colorScheme = 'light';
  iframe.srcdoc = `<!doctype html><html class="hide-quotes"><head><meta charset="utf-8"><meta name="color-scheme" content="light only"><base target="_blank"><style>${EMAIL_CSS}</style></head><body>${m.html}</body></html>`;
  body.appendChild(iframe);

  iframe.addEventListener('load', () => {
    const doc = iframe.contentDocument;
    if (!doc?.body) return;
    fitIframe(iframe);
    new ResizeObserver(() => fitIframe(iframe)).observe(doc.body);
    if (doc.querySelector('.gmail_quote, blockquote[type="cite"]')) {
      const btn = document.createElement('button');
      btn.className = 'quote-toggle';
      btn.dataset.act = 'toggle-quotes';
      btn.title = 'Show trimmed content';
      btn.textContent = '•••';
      iframe.after(btn);
    }
  }, { once: true });
}

// ─── Attachments: thumbnails, preview, download ──────────────────
const blobCache = new Map(); // `${messageId}:${attachmentId}` → object URL

const isImage = (a) => /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i.test(a.mimeType || '');
const isPdf = (a) => /pdf/i.test(a.mimeType || '') || /\.pdf$/i.test(a.filename || '');
const isText = (a) => /^text\/|json|xml|csv/i.test(a.mimeType || '');
const isMedia = (a) => /^(video|audio)\//i.test(a.mimeType || '');
const attIcon = (a) => isImage(a) ? 'image' : isPdf(a) ? 'picture_as_pdf' : 'description';
const attColor = (a) => isImage(a) ? '#d93025' : isPdf(a) ? '#d93025' : '#1a73e8';

function findAttachment(messageId, idx) {
  const m = state.thread?.messages?.find(x => x.id === messageId);
  return m?.attachments?.[idx] ? { m, att: m.attachments[idx] } : null;
}

async function attachmentUrl(messageId, att) {
  const key = `${messageId}:${att.attachmentId}`;
  if (blobCache.has(key)) return blobCache.get(key);
  const email = readingEmail();
  const res = await send({ type: 'GET_ATTACHMENT', accountId: email.accountId, messageId, attachmentId: att.attachmentId });
  if (!res.success) throw new Error(res.error);
  const bin = atob(res.data.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: att.mimeType || 'application/octet-stream' }));
  blobCache.set(key, url);
  return url;
}

function clearAttachmentCache() {
  blobCache.forEach(url => URL.revokeObjectURL(url));
  blobCache.clear();
}

async function loadThumbnails(container) {
  const thumbs = [...container.querySelectorAll('.att-thumb.img:not([data-loaded])')]
    .filter(el => el.offsetParent !== null || el.closest('.msg.open'));
  for (const el of thumbs) {
    el.dataset.loaded = '1';
    const [messageId, idx] = el.dataset.thumb.split(':');
    const found = findAttachment(messageId, Number(idx));
    if (!found || found.att.size > 8_000_000) continue;
    try {
      el.style.backgroundImage = `url("${await attachmentUrl(messageId, found.att)}")`;
    } catch (e) {
      el.innerHTML = `<span class="att-big" style="color:#d93025">${icon('image', 40)}</span>`;
    }
  }
}

async function downloadAttachment(messageId, idx) {
  const found = findAttachment(messageId, idx);
  if (!found) return;
  toast(`Downloading ${found.att.filename}…`);
  try {
    const url = await attachmentUrl(messageId, found.att);
    const a = document.createElement('a');
    a.href = url;
    a.download = found.att.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    hideToast();
  } catch (err) {
    toast(`Couldn't download the attachment: ${err.message}`);
  }
}

// Full-screen viewer, like Gmail's attachment preview
let viewerState = null;

async function openViewer(messageId, idx) {
  const found = findAttachment(messageId, idx);
  if (!found) return;
  viewerState = { messageId, idx };
  const { m, att } = found;
  const root = overlay();
  const viewer = root.getElementById('viewer');
  const many = m.attachments.length > 1;
  viewer.innerHTML = `
    <div class="v-bar">
      <span class="v-ic" style="color:${attColor(att)}">${icon(attIcon(att))}</span>
      <span class="v-name">${esc(att.filename)}</span>
      <span class="v-size">${esc(fmtSize(att.size))}</span>
      <span class="spacer"></span>
      <button class="v-btn" data-v="open" title="Open in new tab">${icon('open_in_new')}</button>
      <button class="v-btn" data-v="download" title="Download">${icon('download')}</button>
      <button class="v-btn" data-v="close" title="Close (Esc)">${icon('close')}</button>
    </div>
    <div class="v-stage" data-v="backdrop"><div class="loading light"><span class="ring"></span>Loading preview…</div></div>
    ${many ? `<button class="v-nav prev" data-v="prev" title="Previous"${idx === 0 ? ' disabled' : ''}>${icon('chevron_left', 32)}</button>
      <button class="v-nav next" data-v="next" title="Next"${idx === m.attachments.length - 1 ? ' disabled' : ''}>${icon('chevron_right', 32)}</button>` : ''}`;
  viewer.hidden = false;

  const stage = viewer.querySelector('.v-stage');
  try {
    const url = await attachmentUrl(messageId, att);
    if (viewerState?.messageId !== messageId || viewerState.idx !== idx) return;
    if (isImage(att)) stage.innerHTML = `<img class="v-img" src="${url}" alt="${esc(att.filename)}">`;
    else if (isPdf(att)) stage.innerHTML = `<iframe class="v-doc" src="${url}" title="${esc(att.filename)}"></iframe>`;
    else if (isMedia(att)) stage.innerHTML = /^video/i.test(att.mimeType) ? `<video class="v-img" src="${url}" controls autoplay></video>` : `<audio src="${url}" controls autoplay></audio>`;
    else if (isText(att) && att.size < 2_000_000) {
      const text = await (await fetch(url)).text();
      stage.innerHTML = `<pre class="v-text">${esc(text)}</pre>`;
    } else {
      stage.innerHTML = `<div class="v-none">${icon(attIcon(att), 64)}<p>No preview available</p><button class="v-dl" data-v="download">${icon('download')} Download</button></div>`;
    }
  } catch (err) {
    stage.innerHTML = `<div class="v-none">${icon('warning', 48)}<p>Couldn't load the preview: ${esc(err.message)}</p></div>`;
  }
}

function closeViewer() {
  viewerState = null;
  const viewer = hosts.overlay?.getElementById('viewer');
  if (viewer) { viewer.hidden = true; viewer.innerHTML = ''; }
}

async function onViewerClick(e) {
  const act = e.target.closest('[data-v]')?.dataset.v;
  if (!act || !viewerState) return;
  const { messageId, idx } = viewerState;
  if (act === 'close' || (act === 'backdrop' && e.target.classList.contains('v-stage'))) closeViewer();
  else if (act === 'download') downloadAttachment(messageId, idx);
  else if (act === 'prev') openViewer(messageId, idx - 1);
  else if (act === 'next') openViewer(messageId, idx + 1);
  else if (act === 'open') {
    const found = findAttachment(messageId, idx);
    if (found) window.open(await attachmentUrl(messageId, found.att), '_blank');
  }
}

// ─── Gmail's own search box drives a cross-account search ───────
function gmailSearchInput() {
  return document.querySelector('form[role="search"] input[name="q"]') || document.querySelector('form[role="search"] input');
}

async function runSearch(query) {
  query = (query || '').trim();
  if (!query) { clearSearch(); return; }
  state.searchQuery = query;
  state.searchResults = [];
  state.searching = true;
  state.page = 0;
  state.focusIndex = -1;
  state.selected.clear();
  const input = gmailSearchInput();
  if (input && input.value !== query) input.value = query;
  if (state.readingKey) navigate(state.filter, null);
  else renderList();

  // "Current view": the selected account tab and the categories shown; "All mail": everything
  const inView = state.prefs.searchScope === 'view';
  state.searchScopeLabel = !inView ? 'in all accounts'
    : state.filter === 'all' ? 'in the current view' : `in ${getAccount(state.filter)?.name || 'this account'} (current view)`;
  const res = await send({ type: 'SEARCH', query, inView, accountIds: inView && state.filter !== 'all' ? [state.filter] : [] });
  if (state.searchQuery !== query) return; // a newer search replaced this one
  state.searching = false;
  if (!res.success) {
    toast(`Search failed: ${res.error}`);
  } else {
    state.searchResults = res.results || [];
    if (res.errors?.length) toast(`Some accounts couldn't be searched — ${res.errors[0]}`);
  }
  if (!state.readingKey) renderList();
}

function clearSearch({ render = true } = {}) {
  state.searchQuery = null;
  state.searchResults = [];
  state.searching = false;
  state.page = 0;
  state.focusIndex = -1;
  state.selected.clear();
  const input = gmailSearchInput();
  if (input) input.value = '';
  if (render && state.panelVisible && !state.readingKey) renderList();
}

function setSearchPlaceholder(active) {
  const input = gmailSearchInput();
  if (!input) return;
  if (active) {
    if (input.dataset.uiPlaceholder === undefined) input.dataset.uiPlaceholder = input.placeholder || '';
    input.placeholder = state.prefs.searchScope === 'view' ? 'Search the current view' : 'Search all accounts';
  } else if (input.dataset.uiPlaceholder !== undefined) {
    input.placeholder = input.dataset.uiPlaceholder;
    delete input.dataset.uiPlaceholder;
  }
}

// The magnifier button is the first button of Gmail's search form
function onGmailSearchClick(e) {
  if (!state.panelVisible) return;
  const path = e.composedPath();
  if (path.some(el => el?.getAttribute?.('gh') === 'cm')) {
    e.preventDefault();
    e.stopImmediatePropagation();
    openCompose();
    return;
  }
  const btn = e.composedPath().find(el => el?.matches?.('form[role="search"] button'));
  if (!btn || btn !== btn.closest('form').querySelector('button')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  runSearch(gmailSearchInput()?.value);
}

// ══════════════════════════════════════════════════════════════════
//  7 · KEYBOARD SHORTCUTS (Gmail-style, only while the view is open)
// ══════════════════════════════════════════════════════════════════
function onKeyDown(e) {
  if (e.key === 'Enter' && state.panelVisible) {
    const el = e.composedPath()[0];
    if (el?.closest?.('form[role="search"]')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      runSearch(el.value);
      el.blur();
      return;
    }
  }
  if (e.key === 'Escape') {
    if (closeTopOverlay()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (state.headerMenuOpen) { setHeaderMenu(false); return; }
  }
  if (viewerState && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const found = findAttachment(viewerState.messageId, viewerState.idx + (e.key === 'ArrowLeft' ? -1 : 1));
    if (found) openViewer(viewerState.messageId, viewerState.idx + (e.key === 'ArrowLeft' ? -1 : 1));
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  if (!state.panelVisible || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (hosts.overlay?.getElementById('dialog') && !hosts.overlay.getElementById('dialog').hidden) return;

  const reading = !!state.readingKey;
  const { items } = pageEmails();
  const focused = items[state.focusIndex];
  const targets = () => {
    if (reading) return [readingEmail()].filter(Boolean);
    const sel = selectedEmails();
    return sel.length ? sel : focused ? [focused] : [];
  };

  let handled = true;
  switch (e.key) {
    case 'j': reading ? stepReader(1) : setFocus(state.focusIndex + 1); break;
    case 'k': reading ? stepReader(-1) : setFocus(state.focusIndex - 1); break;
    case 'o':
    case 'Enter': if (!reading && focused) navigate(state.filter, focused.key); else handled = false; break;
    case 'u': if (reading) navigate(state.filter, null); else handled = false; break;
    case 'Escape':
      if (reading) navigate(state.filter, null);
      else if (state.searchQuery !== null) clearSearch();
      else handled = false;
      break;
    case 'x':
      if (!reading && focused) {
        if (state.selected.has(focused.key)) state.selected.delete(focused.key);
        else state.selected.add(focused.key);
        updateSelectionUI();
      }
      break;
    case 'e': reading ? readerAction('archive') : runAction(targets(), 'archive'); break;
    case '#': reading ? readerAction('trash') : runAction(targets(), 'trash'); break;
    case '!': reading ? readerAction('spam') : runAction(targets(), 'spam'); break;
    case 's': {
      const t = targets()[0];
      if (t) runAction([t], t.starred ? 'unstar' : 'star');
      break;
    }
    case 'I': runAction(targets(), 'read'); break;
    case 'U': reading ? readerAction('unread') : runAction(targets(), 'unread'); break;
    case '/': gmailSearchInput()?.focus(); break;
    case 'c': openCompose(); break;
    case 'b': {
      const t = targets();
      if (t.length) showSnoozeMenu(reading ? hosts.view.querySelector('[data-act="r-snooze"]') : pointAnchor(innerWidth / 2, innerHeight / 3), t, reading ? () => navigate(state.filter, null) : null);
      break;
    }
    case 'r': if (reading) openReply('reply'); else handled = false; break;
    case 'a': if (reading) openReply('replyAll'); else handled = false; break;
    case 'f': if (reading) openReply('forward'); else handled = false; break;
    default: handled = false;
  }
  if (handled) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

// ══════════════════════════════════════════════════════════════════
//  8 · OVERLAY (menus, dialogs, snackbar)
// ══════════════════════════════════════════════════════════════════
const OVERLAY_CSS = `
  *{box-sizing:border-box}
  ${COMPOSER_CSS}
  [hidden]{display:none!important}
  svg{fill:currentColor;flex-shrink:0}
  button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
  .layer{font-family:${FONT};font-size:14px;color:#1f1f1f}

  .menu{
    position:fixed;z-index:10;min-width:200px;max-width:340px;max-height:60vh;overflow-y:auto;
    background:#fff;border-radius:8px;padding:8px 0;
    box-shadow:0 2px 6px 2px rgba(60,64,67,.15),0 1px 2px 0 rgba(60,64,67,.3);
  }
  .menu-title{padding:4px 16px 8px;font-size:13px;color:#444746}
  .menu-filter{padding:0 12px 8px}
  .menu-filter input{width:100%;height:32px;border:0;border-bottom:1px solid #c4c7c5;outline:0;font:inherit;font-size:14px;padding:0 4px}
  .menu-filter input:focus{border-bottom:2px solid #0b57d0}
  .menu-item{display:flex;align-items:center;gap:16px;height:32px;padding:0 16px;cursor:pointer;white-space:nowrap}
  .menu-item:hover,.menu-item.kb{background:#f1f3f4}
  .menu-item span{overflow:hidden;text-overflow:ellipsis}
  .menu-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
  .menu-ic{display:flex;color:#444746;width:20px}
  .menu-label{flex:1}
  .menu-more{display:flex;color:#444746;margin-right:-8px}
  .menu-sep{height:1px;background:#e0e0e0;margin:8px 0}
  .menu-empty{padding:8px 16px;color:#444746;font-size:13px}

  .snackbar{
    position:fixed;left:24px;bottom:24px;z-index:4;min-width:288px;max-width:min(560px,calc(100vw - 48px));
    display:flex;align-items:center;gap:8px;padding:6px 8px 6px 16px;min-height:48px;
    background:#303030;color:#f2f2f2;border-radius:4px;font-size:14px;line-height:20px;
    box-shadow:0 3px 5px -1px rgba(0,0,0,.2),0 6px 10px 0 rgba(0,0,0,.14),0 1px 18px 0 rgba(0,0,0,.12);
    transform:translateY(16px);opacity:0;transition:opacity .15s,transform .15s;pointer-events:none;
  }
  .snackbar.visible{transform:none;opacity:1;pointer-events:auto}
  .sb-msg{flex:1;padding:8px 0}
  .sb-action{color:#a8c7fa;font-weight:500;padding:8px 12px;border-radius:4px;white-space:nowrap}
  .sb-action:hover{background:rgba(168,199,250,.12)}
  .sb-close{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#f2f2f2}
  .sb-close:hover{background:rgba(255,255,255,.12)}

  .viewer{position:fixed;inset:0;z-index:9;background:rgba(0,0,0,.87);display:flex;flex-direction:column;color:#fff}
  .v-bar{display:flex;align-items:center;gap:12px;height:64px;padding:0 16px;flex-shrink:0;background:linear-gradient(rgba(0,0,0,.65),rgba(0,0,0,0))}
  .v-ic{display:flex;background:#fff;border-radius:4px;padding:2px}
  .v-name{font-size:15px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:50vw}
  .v-size{font-size:13px;color:#c4c7c5}
  .v-bar .spacer{flex:1}
  .v-btn{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff}
  .v-btn:hover{background:rgba(255,255,255,.12)}
  .v-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:0 72px 24px;overflow:auto}
  .v-img{max-width:100%;max-height:100%;object-fit:contain;box-shadow:0 4px 16px rgba(0,0,0,.5);background:#fff}
  .v-doc{width:min(1000px,100%);height:100%;border:0;background:#fff}
  .v-text{width:min(1000px,100%);max-height:100%;overflow:auto;background:#fff;color:#1f1f1f;padding:24px;margin:0;font:13px/1.5 "Roboto Mono",monospace;white-space:pre-wrap}
  .v-none{display:flex;flex-direction:column;align-items:center;gap:16px;color:#e3e3e3;font-size:15px}
  .v-dl{display:flex;align-items:center;gap:8px;height:40px;padding:0 20px;border-radius:20px;background:#a8c7fa;color:#062e6f;font-weight:500}
  .v-nav{position:fixed;top:50%;transform:translateY(-50%);width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;background:rgba(0,0,0,.4)}
  .v-nav:hover{background:rgba(255,255,255,.15)}
  .v-nav[disabled]{opacity:.25;pointer-events:none}
  .v-nav.prev{left:12px}
  .v-nav.next{right:12px}
  .loading{display:flex;align-items:center;gap:12px;color:#444746}
  .loading.light{color:#e3e3e3}
  .loading .ring{width:20px;height:20px;border:2px solid #d3e3fd;border-top-color:#0b57d0;border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .drop-panel{
    position:fixed;z-index:6;background:#fff;border-radius:16px;padding:8px 0;overflow-y:auto;
    box-shadow:0 4px 8px 3px rgba(60,64,67,.15),0 1px 3px rgba(60,64,67,.3);
  }
  .dp-head{display:flex;align-items:center;gap:8px;padding:8px 16px 2px;font-size:14px;font-weight:500;color:#1f1f1f}
  .dp-head .dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
  .dp-sub{padding:0 16px 8px;font-size:12px;color:#444746}
  .drop-item{display:flex;align-items:center;gap:16px;height:36px;margin-right:12px;padding:0 16px 0 20px;border-radius:0 18px 18px 0;font-size:14px;color:#1f1f1f;transition:background .08s}
  .drop-item svg{width:20px;height:20px;color:#444746;pointer-events:none}
  .drop-item span{pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .drop-item.over{background:#d3e3fd;color:#041e49;font-weight:700}
  .dp-sep{height:1px;background:#e0e0e0;margin:6px 0}
  .dp-empty{padding:6px 20px;font-size:13px;color:#444746}
  .scrim{position:fixed;inset:0;z-index:5;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;padding:24px}
  .dialog{
    background:#fff;border-radius:28px;padding:24px;width:100%;max-width:520px;max-height:calc(100vh - 48px);overflow:auto;
    box-shadow:0 4px 8px 3px rgba(0,0,0,.15),0 1px 3px rgba(0,0,0,.3);
  }
  .dialog h2{font-size:22px;font-weight:400;line-height:28px;color:#1f1f1f;margin:0 0 16px}
  .d-body{font-size:14px;line-height:20px;color:#444746}
  .d-body p{margin:0 0 10px}
  .d-body ol{margin:0 0 10px;padding-left:20px}
  .d-body li{margin-bottom:8px}
  .d-body code{font-family:"Roboto Mono",monospace;font-size:12px;background:#f1f3f4;border-radius:4px;padding:1px 4px}
  .d-body code.sel{user-select:all;display:inline-block;margin-top:4px;word-break:break-all}
  .d-input{width:100%;height:48px;border:1px solid #747775;border-radius:4px;padding:0 14px;font:inherit;font-size:16px;margin-top:8px;outline:0}
  .d-input:focus{border:2px solid #0b57d0;padding:0 13px}
  .d-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}
  .planner{max-width:560px}
  .pl-list{max-height:55vh;overflow-y:auto;margin:0 -8px}
  .pl-sec{display:flex;align-items:center;gap:8px;padding:12px 8px 6px;font-size:13px;font-weight:500;color:#444746;text-transform:uppercase;letter-spacing:.04em}
  .pl-n{font-size:12px;background:#e9eef6;border-radius:10px;padding:0 8px;letter-spacing:0}
  .pl-row{display:flex;align-items:center;gap:12px;padding:8px;border-radius:12px}
  .pl-row:hover{background:#f6f8fc}
  .pl-main{flex:1;min-width:0}
  .pl-subj{font-size:14px;color:#1f1f1f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pl-meta{display:flex;align-items:center;gap:6px;font-size:12px;color:#444746;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pl-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .pl-empty{padding:4px 8px 8px;font-size:13px;color:#747775}
  .pl-note{font-size:12px;color:#444746;margin-top:12px;line-height:18px}
  .lm{max-width:480px}
  .lm h2{margin-bottom:4px}
  .lm-acc{display:flex;align-items:center;gap:8px;font-size:13px;color:#444746;margin-bottom:12px}
  .lm-dot{width:10px;height:10px;border-radius:50%}
  .lm-list{max-height:50vh;overflow-y:auto;border-top:1px solid #e0e0e0;border-bottom:1px solid #e0e0e0}
  .lm-row{display:flex;align-items:center;gap:12px;height:44px;padding:0 4px}
  .lm-row + .lm-row{border-top:1px solid #f1f3f4}
  .lm-sw{width:14px;height:14px;border-radius:3px;flex-shrink:0;box-shadow:inset 0 0 0 1px rgba(0,0,0,.1)}
  .lm-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px;color:#1f1f1f}
  .lm-btn{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#444746}
  .lm-btn:hover{background:rgba(68,71,70,.08)}
  .lm-btn.danger:hover{color:#d93025;background:#fce8e6}
  .lm-empty{padding:16px 4px;color:#444746;font-size:14px}
  .d-btn svg{vertical-align:middle;margin-right:4px}
  .d-btn{height:40px;padding:0 16px;border-radius:20px;font-weight:500;color:#0b57d0}
  .d-btn:hover{background:rgba(11,87,208,.08)}
`;

function overlay() {
  if (!hosts.overlay) {
    const host = document.createElement('div');
    host.id = 'ui-overlay-root';
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${OVERLAY_CSS}</style>
      <div class="layer">
        <div class="menu" id="menu" role="menu" hidden></div>
        <div class="snackbar" id="snackbar" role="status" aria-live="polite">
          <span class="sb-msg" id="sb-msg"></span>
          <button class="sb-action" id="sb-action" hidden></button>
          <button class="sb-close" id="sb-close" title="Close">${icon('close', 18)}</button>
        </div>
        <div class="scrim" id="dialog" hidden></div>
        <div class="drop-panel" id="drop-panel" hidden></div>
        <div class="compose-dock" id="compose"></div>
        <div class="viewer" id="viewer" hidden></div>
      </div>`;
    root.getElementById('menu').addEventListener('click', onMenuClick);
    root.getElementById('sb-close').addEventListener('click', hideToast);
    root.getElementById('viewer').addEventListener('click', onViewerClick);
    const panel = root.getElementById('drop-panel');
    panel.addEventListener('dragover', onDropPanelOver);
    panel.addEventListener('dragleave', (e) => e.target.closest?.('.drop-item')?.classList.remove('over'));
    panel.addEventListener('drop', onDropPanelDrop);
    isolateEvents(host);
    hosts.overlayHost = host;
    hosts.overlay = root;
  }
  if (!hosts.overlayHost.isConnected) document.body.appendChild(hosts.overlayHost);
  return hosts.overlay;
}

// ─── Menu ────────────────────────────────────────────────────────
let menuState = null;

function showMenu(anchor, { title, items, filterPlaceholder, empty }) {
  if (menuState?.anchor === anchor) { hideMenu(); return; }
  const root = overlay();
  const menu = root.getElementById('menu');
  menuState = { anchor, items };

  menu.innerHTML = `
    ${title ? `<div class="menu-title">${esc(title)}</div>` : ''}
    ${filterPlaceholder ? `<div class="menu-filter"><input id="menu-filter" placeholder="${esc(filterPlaceholder)}"></div>` : ''}
    <div id="menu-items"></div>`;
  renderMenuItems('', empty);
  menu.hidden = false;

  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;

  const filter = root.getElementById('menu-filter');
  if (filter) {
    filter.focus();
    filter.addEventListener('input', () => renderMenuItems(filter.value, empty));
    filter.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') root.querySelector('.menu-item')?.click();
      if (e.key === 'Escape') hideMenu();
    });
  }
}

function renderMenuItems(query, empty) {
  const root = hosts.overlay;
  const q = normalize(query);
  const html = menuState.items.map((it, i) => {
    if (it.sep) return q ? '' : '<div class="menu-sep"></div>';
    if (q && !normalize(it.label).includes(q)) return '';
    return `<div class="menu-item" role="menuitem" data-idx="${i}">
      ${it.icon ? `<span class="menu-ic">${icon(it.icon)}</span>` : ''}
      ${it.dot ? `<span class="menu-dot" style="background:${esc(it.dot)}"></span>` : ''}
      <span class="menu-label">${esc(it.label)}</span>
      ${it.more ? `<span class="menu-more">${icon('arrow_right', 18)}</span>` : ''}
    </div>`;
  }).join('');
  root.getElementById('menu-items').innerHTML = html.trim() || `<div class="menu-empty">${esc(empty || 'No results')}</div>`;
}

function onMenuClick(e) {
  const item = e.target.closest('.menu-item');
  if (!item || !menuState) return;
  const entry = menuState.items[Number(item.dataset.idx)];
  hideMenu();
  entry?.onClick?.();
}

function hideMenu() {
  menuState = null;
  if (hosts.overlay) hosts.overlay.getElementById('menu').hidden = true;
}

function onDocumentMouseDown(e) {
  const path = e.composedPath();
  if (menuState && !path.includes(hosts.overlay?.getElementById('menu')) && !path.includes(menuState.anchor)) hideMenu();
  if (state.headerMenuOpen && !path.includes(hosts.headerHost) && !path.includes(hosts.overlayHost)) setHeaderMenu(false);
}

function closeTopOverlay() {
  if (menuState) { hideMenu(); return true; }
  if (plannerOpen) { closePlanner(); return true; }
  if (viewerState) { closeViewer(); return true; }
  return false;
}

// ─── Snackbar ────────────────────────────────────────────────────
let toastTimer = null;

function toast(message, { action, onAction, duration } = {}) {
  const root = overlay();
  const bar = root.getElementById('snackbar');
  root.getElementById('sb-msg').textContent = message;
  const btn = root.getElementById('sb-action');
  btn.hidden = !action;
  btn.textContent = action || '';
  btn.onclick = action ? () => { hideToast(); onAction?.(); } : null;
  bar.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration || (action ? 8000 : 4000));
}

function hideToast() {
  clearTimeout(toastTimer);
  hosts.overlay?.getElementById('snackbar').classList.remove('visible');
}

// ─── Dialog ──────────────────────────────────────────────────────
function dialog({ title, body = '', input = null, inputType = 'text', confirm = 'OK', cancel = 'Cancel' }) {
  const root = overlay();
  const scrim = root.getElementById('dialog');
  hideMenu();

  return new Promise((resolve) => {
    scrim.innerHTML = `
      <div class="dialog" role="alertdialog" aria-modal="true">
        <h2>${title}</h2>
        <div class="d-body">${body}</div>
        ${input !== null ? `<input class="d-input" id="d-input" type="${esc(inputType)}" value="${esc(input)}"${inputType === 'text' ? ' maxlength="60"' : ''}>` : ''}
        <div class="d-actions">
          ${cancel ? `<button class="d-btn" data-r="cancel">${esc(cancel)}</button>` : ''}
          <button class="d-btn" data-r="ok">${esc(confirm)}</button>
        </div>
      </div>`;
    scrim.hidden = false;

    const field = root.getElementById('d-input');
    const finish = (ok) => {
      scrim.hidden = true;
      scrim.innerHTML = '';
      resolve(ok ? (field ? field.value : true) : false);
    };
    scrim.onclick = (e) => {
      if (e.target === scrim) finish(false);
      const r = e.target.closest('[data-r]')?.dataset.r;
      if (r) finish(r === 'ok');
    };
    scrim.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter' && (field || e.target.dataset.r !== 'cancel')) finish(true);
    };
    if (field) { field.focus(); field.select(); }
    else scrim.querySelector('[data-r="ok"]').focus();
  });
}
