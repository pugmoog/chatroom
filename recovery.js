// Recovery is managed only in the top-level Pugmoog storage context.
const keyName = 'pugmoog-device-identity-v1';
const cookieName = 'pugmoog_device_identity';
const valid = value => /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(value?.userId || '') && /^[a-f0-9]{64}$/.test(value?.secret || '');
const encode = bytes => btoa(String.fromCharCode(...bytes));
const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
document.querySelector('main').innerHTML = `<h1>Recovery file</h1><p>Save a backup, or restore your ID. After restoring, return to Chatroom and reconnect.</p><p>Use a private password of at least 10 characters. Anyone with both the file and password can use your ID.</p><label>Recovery password <input id="password" type="password" autocomplete="off" minlength="10"></label><p><button id="save">Save recovery file</button></p><label>Restore a file <input id="file" type="file" accept=".chatroom"></label><p id="status" role="status"></p>`;
const status = document.querySelector('#status');
async function cryptoKey(salt) {
  const password = document.querySelector('#password').value;
  if (password.length < 10 || password.length > 1024) throw new Error('Use a password between 10 and 1024 characters.');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256'}, material, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
function readIdentity() {
  try {
    const identity = JSON.parse(localStorage.getItem(keyName));
    if (valid(identity)) return identity;
  } catch {}
  const cookie = document.cookie.split('; ').find(c => c.startsWith(cookieName + '='));
  try { const identity = JSON.parse(decodeURIComponent(cookie?.slice(cookieName.length + 1))); if (valid(identity)) return identity; } catch {}
  throw new Error('Connect Chatroom first, then open this page again.');
}
async function run(work) {
  document.querySelectorAll('button,input').forEach(el => el.disabled = true);
  status.textContent = 'Working…';
  try { await work(); } catch (error) { status.textContent = error.message; }
  finally { document.querySelectorAll('button,input').forEach(el => el.disabled = false); }
}
document.querySelector('#save').onclick = () => run(async () => {
  const identity = readIdentity();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await cryptoKey(salt);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, new TextEncoder().encode(JSON.stringify({userId: identity.userId, secret: identity.secret}))));
  const bytes = new Uint8Array(1 + salt.length + iv.length + ciphertext.length);
  bytes[0] = 1; bytes.set(salt, 1); bytes.set(iv, 17); bytes.set(ciphertext, 29);
  const url = URL.createObjectURL(new Blob([encode(bytes)], {type: 'application/octet-stream'}));
  const link = document.createElement('a'); link.href = url; link.download = 'chatroom-recovery.chatroom'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  document.querySelector('#password').value = '';
  status.textContent = 'Recovery file saved. Keep its password separately.';
});
document.querySelector('#file').onchange = event => {
  const file = event.target.files[0];
  if (!file) return;
  run(async () => {
    if (file.size > 4096) throw new Error('That is not a Chatroom recovery file.');
    let identity;
    try {
      const bytes = decode((await file.text()).trim());
      if (bytes[0] !== 1 || bytes.length < 46) throw new Error();
      const key = await cryptoKey(bytes.slice(1, 17));
      const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: bytes.slice(17, 29)}, key, bytes.slice(29));
      identity = JSON.parse(new TextDecoder().decode(plain));
      if (!valid(identity)) throw new Error();
    } catch { throw new Error('Could not unlock this file. Check the password and file.'); }
    // Verify existing credentials without registering a new or expired identity.
    const response = await fetch('https://d3txi12i3pqbxm.cloudfront.net/chet/chat/api/me', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({_method: 'GET', _auth: identity})});
    if (!response.ok) throw new Error('Could not verify this ID. Try again later; expired IDs cannot be restored.');
    if (!confirm('Use this recovered ID for future Chatroom connections?')) { status.textContent = 'Nothing changed.'; return; }
    localStorage.setItem(keyName, JSON.stringify(identity));
    document.cookie = `${cookieName}=${encodeURIComponent(JSON.stringify(identity))}; Path=/; Max-Age=34560000; SameSite=Lax; Secure`;
    document.querySelector('#password').value = '';
    status.textContent = 'Ready. Return to Chatroom and reconnect.';
  });
};
