/* ================================================================
   UNIFIED INBOX — OAuth configuration
   ================================================================

   Each user signs in with an OAuth client from their own Google Cloud
   project (see the README, "Set up"): a "Web application" client whose
   Authorized redirect URIs include this extension's
   https://<extension-id>.chromiumapp.org/ (shown in the popup). The client
   ID is pasted in the popup and kept in chrome.storage.local.
   ================================================================ */

const CLIENT_ID_PATTERN = /^[\w-]+\.apps\.googleusercontent\.com$/;

export function isClientId(value) {
  return CLIENT_ID_PATTERN.test(String(value || '').trim());
}

export async function getClientId() {
  const { oauthClientId = '' } = await chrome.storage.local.get('oauthClientId');
  return oauthClientId.trim();
}
