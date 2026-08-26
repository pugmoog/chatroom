const API = "https://d3txi12i3pqbxm.cloudfront.net/chat/api";
const STORAGE_KEY = "pugmoog-chat-v1";
const app = document.querySelector("#app");
const toastNode = document.querySelector("#toast");
const imageUrls = new Map();
let pollTimer = null;
let streamController = null;
let toastTimer = null;
let currentView = "home";
let activeChat = null;

function randomHex(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return [...data].map(value => value.toString(16).padStart(2, "0")).join("");
}

function randomUserId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const data = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...data].map(value => alphabet[value % alphabet.length]);
  return [0, 4, 8, 12].map(index => chars.slice(index, index + 4).join("")).join("-");
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved?.userId && saved?.secret) return { ...saved, chats: Array.isArray(saved.chats) ? saved.chats : [] };
  } catch {}
  return { userId: randomUserId(), secret: randomHex(), displayName: "", ownedChat: null, chats: [] };
}

let state = loadState();
const saveState = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
saveState();

function requestBody(body, chatToken, method) {
  let payload = {};
  if (typeof body === "string" && body) payload = JSON.parse(body);
  return JSON.stringify({
    ...payload,
    _method: method,
    _auth: { userId: state.userId, secret: state.secret, chatToken: chatToken || null }
  });
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: options.signal,
    body: requestBody(options.body, options.chatToken, method)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    Object.assign(error, data, { status: response.status });
    throw error;
  }
  return data;
}

async function establishIdentity() {
  try {
    const me = await api("/identity", { method: "POST", body: JSON.stringify({ userId: state.userId, secret: state.secret }) });
    state.displayName = me.displayName || state.displayName || "";
    state.ownedChat = me.ownedChat;
    saveState();
  } catch (error) {
    if (error.status === 409 || error.status === 401) {
      state = { userId: randomUserId(), secret: randomHex(), displayName: "", ownedChat: null, chats: [] };
      saveState();
      await establishIdentity();
    } else throw error;
  }
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  toastNode.textContent = message;
  toastNode.className = `toast show${error ? " error" : ""}`;
  toastTimer = setTimeout(() => toastNode.className = "toast", 4200);
}

function setActiveNav(view) {
  document.querySelectorAll("nav button").forEach(button => button.classList.toggle("active", button.dataset.action === view));
}

function stopLive() {
  clearInterval(pollTimer);
  pollTimer = null;
  streamController?.abort();
  streamController = null;
  for (const url of imageUrls.values()) URL.revokeObjectURL(url);
  imageUrls.clear();
}

function homeView() {
  stopLive();
  currentView = "home";
  activeChat = null;
  setActiveNav("home");
  const chats = state.chats.map((chat, index) => `
    <button class="chat-tile" data-open-chat="${index}">
      <strong>${escapeHtml(chat.name)}</strong>
      <small>${chat.owner ? "Owned by you" : "Joined chat"}</small>
    </button>`).join("");
  app.innerHTML = `
    <section class="center-card hero">
      <h1>Chatroom</h1>
      <p>Make a chat, or join one with its name and password. Messages and images disappear after 48 hours.</p>
      <div class="actions">
        <button class="primary" data-action="create" ${state.ownedChat ? "disabled title='This browser already owns a chat'" : ""}>Create a chat</button>
        <button class="secondary" data-action="join">Join a chat</button>
      </div>
      <button class="identity-card" data-action="identity"><small>Your personal ID</small><strong>${state.userId}</strong></button>
    </section>
    <section>
      <div class="section-head"><h2>Your chats</h2><span class="hint">Saved only in this browser</span></div>
      <div class="chat-grid">${chats || '<div class="empty">No chats saved yet.</div>'}</div>
    </section>`;
}

function openDialog(id) {
  const dialog = document.querySelector(id);
  const name = dialog.querySelector("[name=displayName]");
  if (name) name.value = state.displayName || "";
  dialog.showModal();
}

function storeChat(chat, token) {
  const existing = state.chats.find(item => item.id === chat.id);
  const record = { id: chat.id, name: chat.name, token, owner: chat.isOwner };
  if (existing) Object.assign(existing, record); else state.chats.push(record);
  if (chat.isOwner) state.ownedChat = chat.name;
  saveState();
  return existing || record;
}

async function openChat(ref) {
  stopLive();
  currentView = "chat";
  activeChat = ref;
  setActiveNav("home");
  app.innerHTML = '<section class="center-card"><div class="spinner"></div><p>Opening chat…</p></section>';
  try {
    const data = await api(`/chats/${encodeURIComponent(ref.name)}/messages`, { chatToken: ref.token });
    ref.name = data.chat.name;
    ref.owner = data.chat.isOwner;
    saveState();
    renderChat(data.chat, data.messages);
    startChatLive(ref);
  } catch (error) {
    if (error.logout) {
      state.chats = state.chats.filter(item => item.id !== ref.id);
      saveState();
      homeView();
      showToast("That chat password changed. Join again with the new password.", true);
    } else {
      homeView();
      showToast(error.message, true);
    }
  }
}

function renderChat(chat, messages) {
  const notice = chat.aliasUsed ? `<p class="notice">This chat is now named <strong>${escapeHtml(chat.name)}</strong>. Your saved name has been updated.</p>` : "";
  app.innerHTML = `
    <section class="panel chat-layout">
      <div>
        <header class="chat-head">
          <div><h1>${escapeHtml(chat.name)}</h1><p>${chat.isOwner ? "You own this chat" : "Joined chat"}</p></div>
          <button class="ghost" data-action="home">← All chats</button>
        </header>
        ${notice}
      </div>
      <div id="messages" class="messages"></div>
      <div>
        <form id="chat-composer" class="composer">
          <div class="composer-row">
            <label class="file-button" title="Attach image">＋<input type="file" name="image" accept="image/png,image/jpeg,image/webp"></label>
            <textarea name="text" maxlength="4000" placeholder="Write a message" aria-label="Chat message"></textarea>
            <button class="primary" type="submit">Send</button>
          </div>
          <div class="composer-meta"><span id="chat-file-name">Images become JPEG ZIPs before upload</span><span id="chat-counter">0/4000</span></div>
        </form>
        ${chat.isOwner ? ownerSettings(chat) : ""}
      </div>
    </section>`;
  appendMessages(messages, activeChat.token, false);
  const box = document.querySelector("#messages");
  box.scrollTop = box.scrollHeight;
  const composer = document.querySelector("#chat-composer");
  const chatText = composer.elements.namedItem("text");
  const chatImage = composer.elements.namedItem("image");
  chatText.addEventListener("input", () => document.querySelector("#chat-counter").textContent = `${chatText.value.length}/4000`);
  chatImage.addEventListener("change", () => document.querySelector("#chat-file-name").textContent = chatImage.files[0]?.name || "Images become JPEG ZIPs before upload");
  composer.addEventListener("submit", sendChatMessage);
  bindOwnerSettings();
}

function ownerSettings(chat) {
  return `<details class="settings">
    <summary>Owner settings</summary>
    <div class="settings-grid">
      <form id="rename-form"><h3>Rename chat</h3><input name="name" maxlength="50" value="${escapeHtml(chat.name)}" required><button class="secondary" type="submit">Rename</button></form>
      <form id="password-form"><h3>Change password</h3><input name="password" type="password" minlength="4" maxlength="128" required><button class="secondary" type="submit">Change password</button></form>
      <form id="clear-form"><h3>Clear messages</h3><p class="hint">Permanently removes every message and image.</p><button class="danger" type="submit">Clear everything</button></form>
    </div>
  </details>`;
}

function bindOwnerSettings() {
  document.querySelector("#rename-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const result = await api(`/chats/${encodeURIComponent(activeChat.name)}/rename`, { method: "PATCH", chatToken: activeChat.token, body: JSON.stringify({ name: event.target.elements.namedItem("name").value }) });
      activeChat.name = result.name;
      state.ownedChat = result.name;
      saveState();
      showToast(`Renamed. “${result.oldName}” works for 24 more hours.`);
      openChat(activeChat);
    } catch (error) { showToast(error.message, true); }
  });
  document.querySelector("#password-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    if (!confirm("Change the password and log everyone else out?")) return;
    try {
      const result = await api(`/chats/${encodeURIComponent(activeChat.name)}/password`, { method: "PATCH", chatToken: activeChat.token, body: JSON.stringify({ password: event.target.elements.namedItem("password").value }) });
      activeChat.token = result.token;
      saveState();
      event.target.reset();
      showToast("Password changed. Everyone else has been logged out.");
      startChatLive(activeChat);
    } catch (error) { showToast(error.message, true); }
  });
  document.querySelector("#clear-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    if (!confirm("Permanently delete every message and image in this chat?")) return;
    try {
      await api(`/chats/${encodeURIComponent(activeChat.name)}/clear`, { method: "DELETE", chatToken: activeChat.token });
      document.querySelector("#messages").replaceChildren();
      showToast("Chat cleared permanently.");
    } catch (error) { showToast(error.message, true); }
  });
}

async function sendChatMessage(event) {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const image = form.elements.namedItem("image");
    const text = form.elements.namedItem("text");
    const imageZip = image.files[0] ? await prepareImage(image.files[0]) : null;
    await api(`/chats/${encodeURIComponent(activeChat.name)}/messages`, { method: "POST", chatToken: activeChat.token, body: JSON.stringify({ text: text.value, imageZip }) });
    form.reset();
    document.querySelector("#chat-counter").textContent = "0/4000";
    document.querySelector("#chat-file-name").textContent = "Images become JPEG ZIPs before upload";
    await refreshChat();
  } catch (error) { showToast(formatCooldown(error), true); }
  finally { button.disabled = false; }
}

function messageElement(message, token, personal) {
  const node = document.createElement("article");
  node.className = `message${message.senderId === state.userId ? " mine" : ""}`;
  const sender = document.createElement("div");
  sender.className = "sender";
  sender.textContent = message.displayName || "Unnamed";
  const id = document.createElement("small");
  id.className = "user-id";
  id.textContent = message.senderId;
  sender.append(id);
  node.append(sender);
  if (message.text) {
    const text = document.createElement("div");
    text.className = "body";
    text.textContent = message.text;
    node.append(text);
  }
  if (message.imageFile) loadImage(message.imageFile, token, personal).then(url => {
    if (!url) return;
    const image = new Image();
    image.src = url;
    image.alt = "Uploaded image";
    node.insertBefore(image, node.querySelector("time"));
  });
  const time = document.createElement("time");
  time.dateTime = new Date(message.createdAt).toISOString();
  time.textContent = new Date(message.createdAt).toLocaleString();
  node.append(time);
  return node;
}

function appendMessages(messages, token, personal) {
  const container = document.querySelector(personal ? "#pm-list" : "#messages");
  if (!container) return;
  const known = new Set([...container.querySelectorAll("[data-message-id]")].map(node => node.dataset.messageId));
  for (const message of messages) {
    if (known.has(message.id)) continue;
    const node = personal ? personalElement(message) : messageElement(message, token, false);
    node.dataset.messageId = message.id;
    container.append(node);
  }
}

async function loadImage(filename, token) {
  if (imageUrls.has(filename)) return imageUrls.get(filename);
  try {
    const response = await fetch(`${API}/images/${encodeURIComponent(filename)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody(null, token, "GET")
    });
    if (!response.ok) return null;
    const url = URL.createObjectURL(await response.blob());
    imageUrls.set(filename, url);
    return url;
  } catch { return null; }
}

async function refreshChat() {
  if (!activeChat || currentView !== "chat") return;
  try {
    const data = await api(`/chats/${encodeURIComponent(activeChat.name)}/messages`, { chatToken: activeChat.token });
    if (data.chat.name !== activeChat.name) {
      activeChat.name = data.chat.name;
      saveState();
      showToast(`This chat is now named “${data.chat.name}”.`);
      return openChat(activeChat);
    }
    const container = document.querySelector("#messages");
    const nearBottom = container && container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    appendMessages(data.messages, activeChat.token, false);
    if (nearBottom && container) container.scrollTop = container.scrollHeight;
  } catch (error) {
    if (error.logout) {
      state.chats = state.chats.filter(item => item.id !== activeChat.id);
      saveState();
      homeView();
      showToast("The chat password changed. Join again.", true);
    }
  }
}

function startChatLive(ref) {
  clearInterval(pollTimer);
  streamController?.abort();
  pollTimer = setInterval(refreshChat, 5000);
  streamController = new AbortController();
  streamEvents(ref, streamController.signal).catch(() => {});
}

async function streamEvents(ref, signal) {
  const response = await fetch(`${API}/chats/${encodeURIComponent(ref.name)}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody(null, ref.token, "GET"),
    signal
  });
  if (!response.ok || !response.body) throw new Error("Live updates unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop();
    if (events.some(event => event.includes("data:"))) refreshChat();
  }
}

function personalView() {
  stopLive();
  currentView = "personal";
  activeChat = null;
  setActiveNav("personal");
  app.innerHTML = `
    <section class="personal-layout">
      <div class="panel personal-compose">
        <h1>Personal message</h1>
        <p class="hint">Send directly to a browser ID. Messages still disappear after 48 hours.</p>
        <form id="personal-form">
          <label>Recipient ID<input name="recipientId" placeholder="ABCD-EFGH-JKLM-NPQR" maxlength="19" required></label>
          <label>Message<textarea name="text" maxlength="15000" placeholder="Write a personal message"></textarea></label>
          <div class="composer-meta"><span id="pm-long-note">One message per minute</span><span id="pm-counter" class="counter">0/4000</span></div>
          <label class="file-button" title="Attach image">＋<input type="file" name="image" accept="image/png,image/jpeg,image/webp"></label>
          <button class="primary" type="submit">Send message</button>
        </form>
      </div>
      <div class="panel inbox">
        <div class="inbox-head"><div><h2>Inbox</h2><p class="hint">Messages sent to ${state.userId}</p></div><button class="secondary small" data-action="refresh-personal">Refresh</button></div>
        <div id="pm-list" class="pm-list"><div class="empty">Loading personal messages…</div></div>
      </div>
    </section>`;
  const form = document.querySelector("#personal-form");
  form.elements.namedItem("text").addEventListener("input", updatePersonalCounter);
  form.addEventListener("submit", sendPersonal);
  loadPersonal();
  pollTimer = setInterval(loadPersonal, 10000);
}

function updatePersonalCounter(event) {
  const length = event.target.value.length;
  const counter = document.querySelector("#pm-counter");
  counter.textContent = `${length}/4000`;
  counter.classList.toggle("long", length > 4000);
  document.querySelector("#pm-long-note").textContent = length > 4000 ? "Long message: 24-hour cooldown after sending" : "One message per minute";
}

async function sendPersonal(event) {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const image = form.elements.namedItem("image");
    const text = form.elements.namedItem("text");
    const recipient = form.elements.namedItem("recipientId");
    const imageZip = image.files[0] ? await prepareImage(image.files[0]) : null;
    const result = await api("/personal", { method: "POST", body: JSON.stringify({ recipientId: recipient.value.trim().toUpperCase(), text: text.value, imageZip }) });
    form.reset();
    document.querySelector("#pm-counter").textContent = "0/4000";
    document.querySelector("#pm-counter").classList.remove("long");
    document.querySelector("#pm-long-note").textContent = "One message per minute";
    showToast(result.longCooldown ? "Sent. Your next personal message can be sent in 24 hours." : "Personal message sent.");
  } catch (error) { showToast(formatCooldown(error), true); }
  finally { button.disabled = false; }
}

async function loadPersonal() {
  if (currentView !== "personal") return;
  try {
    const data = await api("/personal");
    const list = document.querySelector("#pm-list");
    list.replaceChildren();
    if (!data.messages.length) list.innerHTML = '<div class="empty">No personal messages.</div>';
    else for (const message of data.messages) list.append(personalElement(message));
  } catch (error) { showToast(error.message, true); }
}

function personalElement(message) {
  const node = document.createElement("article");
  node.className = "pm";
  node.dataset.messageId = message.id;
  const head = document.createElement("div");
  head.className = "pm-head";
  const sender = document.createElement("strong");
  sender.textContent = message.displayName || "Unnamed";
  const time = document.createElement("time");
  time.textContent = new Date(message.createdAt).toLocaleString();
  head.append(sender, time);
  const id = document.createElement("small");
  id.className = "user-id";
  id.textContent = message.senderId;
  node.append(head, id);
  if (message.text) { const body = document.createElement("p"); body.textContent = message.text; node.append(body); }
  if (message.imageFile) loadImage(message.imageFile).then(url => { if (url) { const img = new Image(); img.src = url; img.alt = "Personal message image"; img.style.maxWidth = "100%"; img.style.borderRadius = "10px"; node.append(img); } });
  const actions = document.createElement("div");
  actions.className = "pm-actions";
  const reply = document.createElement("button");
  reply.className = "secondary small";
  reply.textContent = "Message back";
  reply.onclick = () => {
    const form = document.querySelector("#personal-form");
    form.elements.namedItem("recipientId").value = message.senderId;
    form.elements.namedItem("text").focus();
  };
  const block = document.createElement("button");
  block.className = "danger small";
  block.textContent = "Block ID";
  block.onclick = () => blockUser(message.senderId);
  actions.append(reply, block);
  node.append(actions);
  return node;
}

async function blockUser(userId) {
  if (!confirm(`Block ${userId} from sending future personal messages?`)) return;
  try { await api("/blocks", { method: "POST", body: JSON.stringify({ userId }) }); showToast(`${userId} blocked.`); }
  catch (error) { showToast(error.message, true); }
}

function formatCooldown(error) {
  if (!error.retryAfterMs) return error.message;
  const minutes = Math.ceil(error.retryAfterMs / 60000);
  return `${error.message} Try again in ${minutes >= 60 ? `${Math.ceil(minutes / 60)} hour(s)` : `${minutes} minute(s)`}.`;
}

async function prepareImage(file) {
  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(file.type)) throw new Error("Choose a PNG, JPEG, or WebP image. GIF and SVG are not allowed.");
  if (file.size > 3 * 1024 * 1024) throw new Error("Original images must be 3 MB or smaller.");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let jpeg = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .8));
  if (!jpeg) throw new Error("This browser could not convert the image.");
  let bytes = new Uint8Array(await jpeg.arrayBuffer());
  let zip = makeStoredZip(bytes);
  if (zip.length > 2 * 1024 * 1024) {
    jpeg = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .62));
    bytes = new Uint8Array(await jpeg.arrayBuffer());
    zip = makeStoredZip(bytes);
  }
  if (zip.length > 2 * 1024 * 1024) throw new Error("Converted image is still larger than the 2 MB upload limit.");
  let binary = "";
  for (let index = 0; index < zip.length; index += 32768) binary += String.fromCharCode(...zip.subarray(index, index + 32768));
  return btoa(binary);
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function makeStoredZip(data) {
  const name = new TextEncoder().encode("image.jpg");
  const crc = crc32(data);
  const local = new Uint8Array(30 + name.length + data.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(8, 0, true);
  localView.setUint32(14, crc, true);
  localView.setUint32(18, data.length, true);
  localView.setUint32(22, data.length, true);
  localView.setUint16(26, name.length, true);
  local.set(name, 30);
  local.set(data, 30 + name.length);
  const central = new Uint8Array(46 + name.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint32(16, crc, true);
  centralView.setUint32(20, data.length, true);
  centralView.setUint32(24, data.length, true);
  centralView.setUint16(28, name.length, true);
  central.set(name, 46);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, local.length, true);
  const result = new Uint8Array(local.length + central.length + end.length);
  result.set(local, 0);
  result.set(central, local.length);
  result.set(end, local.length + central.length);
  return result;
}

document.addEventListener("click", event => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "home") homeView();
  if (action === "personal") personalView();
  if (action === "create") openDialog("#create-dialog");
  if (action === "join") openDialog("#join-dialog");
  if (action === "identity") {
    document.querySelector("#copy-id").textContent = state.userId;
    document.querySelector("#identity-dialog").showModal();
  }
  if (action === "refresh-personal") loadPersonal();
  const chatIndex = event.target.closest("[data-open-chat]")?.dataset.openChat;
  if (chatIndex !== undefined) openChat(state.chats[Number(chatIndex)]);
  if (event.target.closest("[data-close]")) event.target.closest("dialog").close();
});

document.querySelector("#copy-id").addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.userId).catch(() => {});
  showToast("User ID copied.");
});

document.querySelector("#create-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await api("/chats", { method: "POST", body: JSON.stringify({
      displayName: form.elements.namedItem("displayName").value,
      name: form.elements.namedItem("chatName").value,
      password: form.elements.namedItem("password").value
    }) });
    state.displayName = result.displayName;
    const chat = storeChat(result.chat, result.token);
    form.closest("dialog").close();
    form.reset();
    await openChat(chat);
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
});

document.querySelector("#join-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await api("/chats/join", { method: "POST", body: JSON.stringify({
      displayName: form.elements.namedItem("displayName").value,
      name: form.elements.namedItem("chatName").value,
      password: form.elements.namedItem("password").value
    }) });
    state.displayName = result.displayName;
    const chat = storeChat(result.chat, result.token);
    form.closest("dialog").close();
    form.reset();
    await openChat(chat);
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
});

window.addEventListener("pagehide", stopLive);
setInterval(() => api("/me").catch(() => {}), 5 * 60 * 1000);

try {
  await establishIdentity();
  homeView();
} catch (error) {
  app.innerHTML = `<section class="center-card"><h1>Could not connect</h1><p>${escapeHtml(error.message)}</p><button class="secondary" onclick="location.reload()">Try again</button></section>`;
}
