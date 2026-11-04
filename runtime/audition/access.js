// Shared by the real audition pages; preview secrets never enter request URLs.
export const token = new URLSearchParams(location.search).get('t') ?? '';
const preview = new URLSearchParams(location.search).get('preview');
const scopedUrl = path => {
  const url = new URL(path, location.href);
  if (preview && !token) url.searchParams.set('preview', preview);
  return url.href;
};
export const mediaUrl = path => {
  const url = new URL(scopedUrl(path));
  if (token) url.searchParams.set('t', token);
  return url.href;
};
const fragment = new URLSearchParams(location.hash.slice(1));
const secret = fragment.get('preview');
const kind = { s: 'session', a: 'album', d: 'delivery' }[location.pathname.split('/')[1]];
const target = location.pathname.split('/').pop();
export let access = token ? 'owner' : 'read-only';
if (secret) {
  // Remove the secret from the current history entry before any other requests.
  history.replaceState(null, '', location.pathname + location.search);
  const response = await fetch('/api/preview/exchange', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: secret, kind, target, preview }),
  });
  if (response.ok) access = (await response.json()).feedback ? 'feedback' : 'read-only';
  else {
    document.body.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'This preview link expired or was revoked. Ask for a new link.' }));
    throw new Error('Preview unavailable');
  }
}
if (!secret && !token) {
  const response = await fetch(scopedUrl(`/api/${kind}/${target}/access`));
  if (response.ok) access = (await response.json()).feedback ? 'feedback' : 'read-only';
}
if (!token) {
  const banner = document.createElement('p');
  banner.textContent = access === 'feedback' ? 'Shared preview · feedback enabled. Publishing and refinement stay with the owner.' : 'Shared preview · listen only. Feedback is not saved.';
  banner.setAttribute('role', 'status');
  document.body.prepend(banner);
}
export const canSend = type => access === 'owner' || (access === 'feedback' && {
  session: ['play', 'lineup', 'duel'], album: ['play', 'mark', 'tags', 'note', 'moment'], delivery: ['device', 'rate', 'note'],
}[kind]?.includes(type));
export const api = (path, init = {}) => fetch(scopedUrl(path), {
  ...init, headers: { ...init.headers, ...(token ? { 'x-beeps-token': token } : {}) },
});
