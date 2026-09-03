import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3040);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const IMAGE_DIR = path.join(DATA_DIR, "images");
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || "https://pugmoog.github.io,http://127.0.0.1:8767,http://localhost:8767").split(","));
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MESSAGE_LIFETIME = 48 * HOUR;
const USER_LIFETIME = 60 * DAY;
const MAX_BODY = 3 * 1024 * 1024;
const MAX_ZIP = 2 * 1024 * 1024;
const MAX_ENCODED_ZIP = Math.ceil(MAX_ZIP * 4 / 3) + 8;
const CHAT_TEXT_LIMIT = 2000;
const PERSONAL_TEXT_LIMIT = 20000;

fs.mkdirSync(IMAGE_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "chat.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    display_name TEXT,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    owner_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    credential_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_aliases (
    name_key TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    credential_version INTEGER NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT,
    image_file TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chat_messages_lookup ON chat_messages(chat_id, created_at);
  CREATE TABLE IF NOT EXISTS personal_messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT,
    image_file TEXT,
    is_long INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS personal_inbox_lookup ON personal_messages(recipient_id, created_at);
  CREATE INDEX IF NOT EXISTS personal_sender_lookup ON personal_messages(sender_id, created_at);
  CREATE TABLE IF NOT EXISTS blocks (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, blocked_id)
  );
`);
const personalColumns = new Set(db.prepare("PRAGMA table_info(personal_messages)").all().map(column => column.name));
if (!personalColumns.has("reply_to_id")) db.exec("ALTER TABLE personal_messages ADD COLUMN reply_to_id TEXT");
if (!personalColumns.has("reply_context")) db.exec("ALTER TABLE personal_messages ADD COLUMN reply_context TEXT");

const sseClients = new Set();
const pendingUploads = new Map();
let expiryTimer = null;
const now = () => Date.now();
const randomId = () => crypto.randomUUID();
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const safeEqual = (a, b) => {
  const aa = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
const normalizeName = value => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");

function messageCooldownMs(length, hasImage = false) {
  if (length === 0 && hasImage) return 5000;
  if (length < 100) return 1000;
  if (length <= 2000) return (length / 100) * 1000;
  if (length <= 10000) return (20 + (length - 2000) / 30) * 1000;
  return (20 + 8000 / 30 + (length - 10000) / 10) * 1000;
}

function validateChatName(value) {
  if (typeof value !== "string") throw apiError(400, "Chat name is required.");
  const name = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 50) throw apiError(400, "Chat names must be 2–50 characters.");
  if (/\p{C}/u.test(name)) throw apiError(400, "Chat name contains unsupported characters.");
  return name;
}

function validateDisplayName(value) {
  if (typeof value !== "string") throw apiError(400, "Display name is required.");
  const name = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 32 || /\p{C}/u.test(name)) throw apiError(400, "Display names must be 1–32 characters.");
  return name;
}

function validatePassword(value) {
  if (typeof value !== "string" || value.length < 4 || value.length > 128) throw apiError(400, "Password must be 4–128 characters.");
  return value;
}

function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, digest: crypto.scryptSync(password, salt, 32).toString("hex") };
}

function passwordMatches(password, salt, expected) {
  const actual = crypto.scryptSync(password, salt, 32).toString("hex");
  return safeEqual(actual, expected);
}

function apiError(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.extra = extra;
  return error;
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-User-ID, X-User-Secret, X-Chat-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  return true;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw apiError(413, "Upload is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw apiError(400, "Invalid JSON request."); }
}

function authenticate(req, body = {}) {
  const id = body._auth?.userId || req.headers["x-user-id"];
  const secret = body._auth?.secret || req.headers["x-user-secret"];
  if (typeof id !== "string" || typeof secret !== "string") throw apiError(401, "Browser identity is required.");
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user || !safeEqual(hash(secret), user.secret_hash)) throw apiError(401, "Browser identity is invalid or expired.");
  db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(now(), id);
  return user;
}

function resolveChat(name) {
  const key = normalizeName(name);
  let chat = db.prepare("SELECT * FROM chats WHERE name_key = ?").get(key);
  if (chat) return { chat, alias: false };
  const alias = db.prepare("SELECT c.* FROM chat_aliases a JOIN chats c ON c.id = a.chat_id WHERE a.name_key = ? AND a.expires_at > ?").get(key, now());
  if (!alias) throw apiError(404, "Chat not found.");
  return { chat: alias, alias: true };
}

function authenticateChat(req, body, name) {
  const user = authenticate(req, body);
  const { chat, alias } = resolveChat(name);
  const token = body._auth?.chatToken || req.headers["x-chat-token"];
  const membership = db.prepare("SELECT * FROM memberships WHERE chat_id = ? AND user_id = ?").get(chat.id, user.id);
  if (!membership || typeof token !== "string" || !safeEqual(hash(token), membership.token_hash) || membership.credential_version !== chat.credential_version) {
    throw apiError(401, "Chat password has changed or access has expired.", { logout: true, currentName: chat.name });
  }
  return { user, chat, membership, alias };
}

function createMembership(chat, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare(`INSERT INTO memberships(chat_id,user_id,token_hash,credential_version,joined_at)
    VALUES(?,?,?,?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET token_hash=excluded.token_hash,credential_version=excluded.credential_version,joined_at=excluded.joined_at`)
    .run(chat.id, userId, hash(token), chat.credential_version, now());
  return token;
}

function ensureNameAvailable(nameKey, excludingChatId = null) {
  const chat = db.prepare("SELECT id FROM chats WHERE name_key = ?").get(nameKey);
  if (chat && chat.id !== excludingChatId) throw apiError(409, "That chat name is already in use.");
  const alias = db.prepare("SELECT chat_id FROM chat_aliases WHERE name_key = ? AND expires_at > ?").get(nameKey, now());
  if (alias && alias.chat_id !== excludingChatId) throw apiError(409, "That chat name is temporarily reserved.");
}

function parseImageZip(encoded) {
  if (!encoded) return null;
  if (typeof encoded !== "string") throw apiError(400, "Invalid image upload.");
  let zip;
  try { zip = Buffer.from(encoded, "base64"); } catch { throw apiError(400, "Invalid image upload."); }
  if (!zip.length || zip.length > MAX_ZIP) throw apiError(413, "Final image ZIP must be 2 MB or smaller.");
  if (zip.length < 30 || zip.readUInt32LE(0) !== 0x04034b50) throw apiError(400, "Image must be a ZIP archive.");
  const flags = zip.readUInt16LE(6);
  const method = zip.readUInt16LE(8);
  const compressed = zip.readUInt32LE(18);
  const uncompressed = zip.readUInt32LE(22);
  const nameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  if (flags !== 0 || method !== 0 || compressed !== uncompressed || uncompressed > MAX_ZIP) throw apiError(400, "ZIP must contain one unencrypted JPEG.");
  const start = 30 + nameLength + extraLength;
  if (start + compressed > zip.length) throw apiError(400, "Truncated image ZIP.");
  const filename = zip.subarray(30, 30 + nameLength).toString("utf8");
  if (filename !== "image.jpg") throw apiError(400, "ZIP must contain exactly image.jpg.");
  const jpeg = zip.subarray(start, start + compressed);
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) throw apiError(400, "Uploaded file is not a valid JPEG.");
  const next = start + compressed;
  if (next + 4 <= zip.length && zip.readUInt32LE(next) === 0x04034b50) throw apiError(400, "ZIP may contain only one file.");
  return jpeg;
}

function saveImage(jpeg) {
  if (!jpeg) return null;
  const filename = `${crypto.randomUUID()}.jpg`;
  fs.writeFileSync(path.join(IMAGE_DIR, filename), jpeg, { flag: "wx", mode: 0o600 });
  return filename;
}

function removeFiles(rows) {
  for (const row of rows) if (row.image_file) {
    try { fs.unlinkSync(path.join(IMAGE_DIR, path.basename(row.image_file))); } catch (error) { if (error.code !== "ENOENT") console.error(error); }
  }
}

function cleanup() {
  const time = now();
  for (const [id, upload] of pendingUploads) if (upload.createdAt < time - 10 * 60 * 1000) pendingUploads.delete(id);
  const chatExpired = db.prepare("SELECT image_file FROM chat_messages WHERE expires_at <= ? AND image_file IS NOT NULL").all(time);
  const personalExpired = db.prepare("SELECT image_file FROM personal_messages WHERE expires_at <= ? AND image_file IS NOT NULL").all(time);
  removeFiles([...chatExpired, ...personalExpired]);
  db.prepare("DELETE FROM chat_messages WHERE expires_at <= ?").run(time);
  db.prepare("DELETE FROM personal_messages WHERE expires_at <= ?").run(time);
  db.prepare("DELETE FROM chat_aliases WHERE expires_at <= ?").run(time);

  const stale = db.prepare("SELECT id FROM users WHERE last_seen <= ?").all(time - USER_LIFETIME);
  for (const { id } of stale) {
    const files = db.prepare(`SELECT image_file FROM chat_messages
      WHERE (chat_id IN (SELECT id FROM chats WHERE owner_id = ?) OR sender_id = ?) AND image_file IS NOT NULL
      UNION ALL SELECT image_file FROM personal_messages WHERE (sender_id = ? OR recipient_id = ?) AND image_file IS NOT NULL`).all(id, id, id, id);
    removeFiles(files);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  }
}

function scheduleExpiryCleanup() {
  clearTimeout(expiryTimer);
  const next = db.prepare(`SELECT MIN(expires_at) AS expiresAt FROM (
    SELECT expires_at FROM chat_messages
    UNION ALL
    SELECT expires_at FROM personal_messages
  )`).get()?.expiresAt;
  if (!next) return;
  const delay = Math.min(2_147_000_000, Math.max(0, next - now()) + 10);
  expiryTimer = setTimeout(() => {
    cleanup();
    scheduleExpiryCleanup();
  }, delay);
  expiryTimer.unref();
}

function broadcast(event, target = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify({ event, at: now(), ...target })}\n\n`;
  for (const client of sseClients) {
    if (target.chatId && client.chatId !== target.chatId) continue;
    if (target.userId && client.userId !== target.userId) continue;
    try { client.res.write(payload); } catch { sseClients.delete(client); }
  }
}

function chatView(chat, user, alias = false) {
  return {
    id: chat.id,
    name: chat.name,
    ownerId: chat.owner_id,
    isOwner: chat.owner_id === user.id,
    aliasUsed: alias,
    credentialVersion: chat.credential_version
  };
}

function messageRows(chatId, since = 0) {
  return db.prepare(`SELECT m.id,m.text,m.image_file AS imageFile,m.created_at AS createdAt,m.expires_at AS expiresAt,
    u.id AS senderId,u.display_name AS displayName
    FROM chat_messages m JOIN users u ON u.id=m.sender_id
    WHERE m.chat_id=? AND m.expires_at>? AND m.created_at>? ORDER BY m.created_at ASC LIMIT 500`).all(chatId, now(), since);
}

function consumeImage(body, userId) {
  if (!body.imageUploadId) return parseImageZip(body.imageZip || null);
  const upload = pendingUploads.get(body.imageUploadId);
  if (!upload || upload.userId !== userId) throw apiError(400, "Image upload is missing or expired. Attach it again.");
  if (upload.chunks.size !== upload.total) throw apiError(400, "Image upload is incomplete. Attach it again.");
  const encoded = Array.from({ length: upload.total }, (_, index) => upload.chunks.get(index)).join("");
  pendingUploads.delete(body.imageUploadId);
  if (encoded.length > MAX_ENCODED_ZIP) throw apiError(413, "Final image ZIP must be 2 MB or smaller.");
  return parseImageZip(encoded);
}

function replyContext(replyToId, userId) {
  if (!replyToId) return { replyToId: null, context: null };
  const message = db.prepare(`SELECT id,text,image_file AS imageFile,reply_context AS replyContext
    FROM personal_messages WHERE id=? AND expires_at>? AND (sender_id=? OR recipient_id=?)`).get(replyToId, now(), userId, userId);
  if (!message) throw apiError(400, "The message you replied to is no longer available.");
  const current = message.text || (message.imageFile ? "[Image]" : "");
  const context = [message.replyContext, current].filter(Boolean).join("\n\n").slice(-1000);
  return { replyToId: message.id, context };
}

async function handle(req, res) {
  if (!cors(req, res)) throw apiError(403, "This API is only available through the Pugmoog website.");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const url = new URL(req.url, "http://localhost");
  if (!url.pathname.startsWith("/chet/chat/api/")) throw apiError(404, "Not found.");
  cleanup();

  if (req.method === "GET" && url.pathname === "/chet/chat/api/health") return sendJson(res, 200, { ok: true });
  const body = req.method === "POST" || req.method === "PATCH" || req.method === "DELETE" ? await readJson(req) : {};
  const method = typeof body._method === "string" ? body._method : req.method;

  if (method === "POST" && url.pathname === "/chet/chat/api/identity") {
    if (!/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(body.userId || "") || !/^[a-f0-9]{64}$/.test(body.secret || "")) throw apiError(400, "Invalid browser identity format.");
    const existing = db.prepare("SELECT * FROM users WHERE id=?").get(body.userId);
    if (existing && !safeEqual(existing.secret_hash, hash(body.secret))) throw apiError(409, "That browser ID already exists.");
    const time = now();
    if (!existing) db.prepare("INSERT INTO users(id,secret_hash,display_name,created_at,last_seen) VALUES(?,?,?,?,?)").run(body.userId, hash(body.secret), null, time, time);
    else db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(time, body.userId);
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(body.userId);
    const owned = db.prepare("SELECT name FROM chats WHERE owner_id=?").get(body.userId);
    return sendJson(res, 200, { userId: user.id, displayName: user.display_name, ownedChat: owned?.name || null });
  }

  const user = authenticate(req, body);

  const uploadMatch = url.pathname.match(/^\/chet\/chat\/api\/uploads\/([a-f0-9-]{36})\/(\d+)$/);
  if (method === "POST" && uploadMatch) {
    const uploadId = uploadMatch[1];
    const index = Number(uploadMatch[2]);
    const total = Number(body.total);
    const chunk = body.chunk;
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > 600 || index < 0 || index >= total) throw apiError(400, "Invalid image chunk.");
    if (typeof chunk !== "string" || chunk.length < 1 || chunk.length > 5500 || !/^[A-Za-z0-9+/=]+$/.test(chunk)) throw apiError(400, "Invalid image chunk.");
    let upload = pendingUploads.get(uploadId);
    if (!upload) {
      if (pendingUploads.size >= 100) throw apiError(503, "Too many images are uploading. Try again shortly.");
      upload = { userId: user.id, total, chunks: new Map(), createdAt: now() };
      pendingUploads.set(uploadId, upload);
    }
    if (upload.userId !== user.id || upload.total !== total) throw apiError(403, "Image upload does not belong to this browser.");
    upload.chunks.set(index, chunk);
    const size = [...upload.chunks.values()].reduce((sum, value) => sum + value.length, 0);
    if (size > MAX_ENCODED_ZIP) { pendingUploads.delete(uploadId); throw apiError(413, "Final image ZIP must be 2 MB or smaller."); }
    return sendJson(res, 200, { received: index, total });
  }

  if (method === "GET" && url.pathname === "/chet/chat/api/me") {
    const owned = db.prepare("SELECT name FROM chats WHERE owner_id=?").get(user.id);
    return sendJson(res, 200, { userId: user.id, displayName: user.display_name, ownedChat: owned?.name || null });
  }

  if (method === "PATCH" && url.pathname === "/chet/chat/api/me") {
    const displayName = validateDisplayName(body.displayName);
    db.prepare("UPDATE users SET display_name=? WHERE id=?").run(displayName, user.id);
    broadcast("identity", { userId: user.id });
    return sendJson(res, 200, { userId: user.id, displayName });
  }

  if (method === "POST" && url.pathname === "/chet/chat/api/chats") {
    const name = validateChatName(body.name);
    const password = validatePassword(body.password);
    const displayName = validateDisplayName(body.displayName || user.display_name || "");
    if (db.prepare("SELECT 1 FROM chats WHERE owner_id=?").get(user.id)) throw apiError(409, "This browser already owns a chat.");
    const nameKey = normalizeName(name);
    ensureNameAvailable(nameKey);
    const { salt, digest } = passwordRecord(password);
    const chat = { id: randomId(), name, name_key: nameKey, owner_id: user.id, credential_version: 1 };
    const time = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE users SET display_name=? WHERE id=?").run(displayName, user.id);
      db.prepare("INSERT INTO chats(id,name,name_key,password_hash,password_salt,owner_id,credential_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(chat.id, name, nameKey, digest, salt, user.id, 1, time, time);
      const token = createMembership(chat, user.id);
      db.exec("COMMIT");
      return sendJson(res, 201, { chat: chatView(chat, user), token, displayName });
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  if (method === "POST" && url.pathname === "/chet/chat/api/chats/join") {
    const { chat, alias } = resolveChat(body.name || "");
    const password = validatePassword(body.password);
    if (!passwordMatches(password, chat.password_salt, chat.password_hash)) throw apiError(401, "Incorrect chat password.");
    const displayName = validateDisplayName(body.displayName || user.display_name || "");
    db.prepare("UPDATE users SET display_name=? WHERE id=?").run(displayName, user.id);
    const token = createMembership(chat, user.id);
    return sendJson(res, 200, { chat: chatView(chat, user, alias), token, displayName });
  }

  const chatMatch = url.pathname.match(/^\/chet\/chat\/api\/chats\/([^/]+)(?:\/(messages|events|rename|password|clear))?$/);
  if (chatMatch) {
    const requestedName = decodeURIComponent(chatMatch[1]);
    const action = chatMatch[2] || "details";
    const auth = authenticateChat(req, body, requestedName);

    if (method === "GET" && action === "details") return sendJson(res, 200, { chat: chatView(auth.chat, auth.user, auth.alias) });

    if (method === "GET" && action === "messages") {
      const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
      return sendJson(res, 200, { chat: chatView(auth.chat, auth.user, auth.alias), messages: messageRows(auth.chat.id, since) });
    }

    if (method === "GET" && action === "events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
      res.write(`event: ready\ndata: ${JSON.stringify({ chatId: auth.chat.id })}\n\n`);
      const client = { res, userId: auth.user.id, chatId: auth.chat.id };
      sseClients.add(client);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);
      req.on("close", () => { clearInterval(heartbeat); sseClients.delete(client); });
      return;
    }

    if (method === "POST" && action === "messages") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text.length > CHAT_TEXT_LIMIT) throw apiError(400, `Chat messages may not exceed ${CHAT_TEXT_LIMIT} characters.`);
      if (!text && !body.imageZip && !body.imageUploadId) throw apiError(400, "Message must contain text or an image.");
      const last = db.prepare("SELECT text,image_file AS imageFile,created_at AS sentAt FROM chat_messages WHERE sender_id=? ORDER BY created_at DESC LIMIT 1").get(user.id);
      const wait = last ? messageCooldownMs(last.text?.length || 0, !!last.imageFile) - (now() - last.sentAt) : 0;
      if (wait > 0) throw apiError(429, "Wait before sending another chat message.", { retryAfterMs: wait });
      const jpeg = consumeImage(body, user.id);
      const imageFile = saveImage(jpeg);
      const time = now();
      const id = randomId();
      try { db.prepare("INSERT INTO chat_messages(id,chat_id,sender_id,text,image_file,created_at,expires_at) VALUES(?,?,?,?,?,?,?)").run(id, auth.chat.id, user.id, text || null, imageFile, time, time + MESSAGE_LIFETIME); }
      catch (error) { if (imageFile) removeFiles([{ image_file: imageFile }]); throw error; }
      scheduleExpiryCleanup();
      broadcast("chat-message", { chatId: auth.chat.id });
      return sendJson(res, 201, { id, createdAt: time, expiresAt: time + MESSAGE_LIFETIME });
    }

    if (auth.chat.owner_id !== user.id) throw apiError(403, "Only the chat owner may do that.");

    if (method === "PATCH" && action === "rename") {
      const name = validateChatName(body.name);
      const nameKey = normalizeName(name);
      ensureNameAvailable(nameKey, auth.chat.id);
      const time = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM chat_aliases WHERE name_key=?").run(auth.chat.name_key);
        db.prepare("INSERT INTO chat_aliases(name_key,chat_id,expires_at) VALUES(?,?,?)").run(auth.chat.name_key, auth.chat.id, time + DAY);
        db.prepare("UPDATE chats SET name=?,name_key=?,updated_at=? WHERE id=?").run(name, nameKey, time, auth.chat.id);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      broadcast("chat-renamed", { chatId: auth.chat.id, name });
      return sendJson(res, 200, { name, oldName: auth.chat.name, aliasExpiresAt: time + DAY });
    }

    if (method === "PATCH" && action === "password") {
      const password = validatePassword(body.password);
      const { salt, digest } = passwordRecord(password);
      const version = auth.chat.credential_version + 1;
      db.prepare("UPDATE chats SET password_hash=?,password_salt=?,credential_version=?,updated_at=? WHERE id=?").run(digest, salt, version, now(), auth.chat.id);
      db.prepare("DELETE FROM memberships WHERE chat_id=?").run(auth.chat.id);
      const updated = { ...auth.chat, credential_version: version };
      const token = createMembership(updated, user.id);
      broadcast("password-changed", { chatId: auth.chat.id });
      return sendJson(res, 200, { token, credentialVersion: version });
    }

    if (method === "DELETE" && action === "clear") {
      const files = db.prepare("SELECT image_file FROM chat_messages WHERE chat_id=? AND image_file IS NOT NULL").all(auth.chat.id);
      db.prepare("DELETE FROM chat_messages WHERE chat_id=?").run(auth.chat.id);
      removeFiles(files);
      broadcast("chat-cleared", { chatId: auth.chat.id });
      return sendJson(res, 200, { cleared: true });
    }
  }

  if (method === "GET" && url.pathname === "/chet/chat/api/personal") {
    const inbox = db.prepare(`SELECT p.id,p.sender_id AS senderId,p.recipient_id AS recipientId,p.text,p.image_file AS imageFile,
      p.reply_to_id AS replyToId,p.reply_context AS replyContext,p.created_at AS createdAt,p.expires_at AS expiresAt,u.display_name AS displayName
      FROM personal_messages p JOIN users u ON u.id=p.sender_id
      WHERE p.recipient_id=? AND p.expires_at>? ORDER BY p.created_at DESC LIMIT 500`).all(user.id, now());
    const outbox = db.prepare(`SELECT p.id,p.sender_id AS senderId,p.recipient_id AS recipientId,p.text,p.image_file AS imageFile,
      p.reply_to_id AS replyToId,p.reply_context AS replyContext,p.created_at AS createdAt,p.expires_at AS expiresAt,u.display_name AS recipientDisplayName
      FROM personal_messages p JOIN users u ON u.id=p.recipient_id
      WHERE p.sender_id=? AND p.expires_at>? ORDER BY p.created_at DESC LIMIT 500`).all(user.id, now());
    const blocked = db.prepare("SELECT blocked_id AS userId FROM blocks WHERE user_id=? ORDER BY created_at DESC").all(user.id);
    return sendJson(res, 200, { messages: inbox, inbox, outbox, blocked: blocked.map(row => row.userId) });
  }

  if (method === "POST" && url.pathname === "/chet/chat/api/personal") {
    const recipientId = String(body.recipientId || "").toUpperCase();
    if (recipientId === user.id) throw apiError(400, "You cannot send a personal message to yourself.");
    if (!db.prepare("SELECT 1 FROM users WHERE id=? AND last_seen>?").get(recipientId, now() - USER_LIFETIME)) throw apiError(404, "Recipient ID was not found.");
    if (db.prepare("SELECT 1 FROM blocks WHERE user_id=? AND blocked_id=?").get(recipientId, user.id)) throw apiError(403, "This recipient is not accepting your messages.");
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length > PERSONAL_TEXT_LIMIT) throw apiError(400, `Personal messages may not exceed ${PERSONAL_TEXT_LIMIT} characters.`);
    if (!text && !body.imageZip && !body.imageUploadId) throw apiError(400, "Message must contain text or an image.");
    const time = now();
    const latest = db.prepare("SELECT text,image_file AS imageFile,created_at AS createdAt FROM personal_messages WHERE sender_id=? ORDER BY created_at DESC LIMIT 1").get(user.id);
    if (latest) {
      const cooldown = messageCooldownMs(latest.text?.length || 0, !!latest.imageFile);
      const wait = cooldown - (time - latest.createdAt);
      if (wait > 0) throw apiError(429, "Wait before sending another personal message.", { retryAfterMs: wait });
    }
    const reply = replyContext(body.replyToId || null, user.id);
    const jpeg = consumeImage(body, user.id);
    const imageFile = saveImage(jpeg);
    const id = randomId();
    try { db.prepare("INSERT INTO personal_messages(id,sender_id,recipient_id,text,image_file,is_long,created_at,expires_at,reply_to_id,reply_context) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id, user.id, recipientId, text || null, imageFile, 0, time, time + MESSAGE_LIFETIME, reply.replyToId, reply.context); }
    catch (error) { if (imageFile) removeFiles([{ image_file: imageFile }]); throw error; }
    scheduleExpiryCleanup();
    broadcast("personal-message", { userId: recipientId });
    const recipient = db.prepare("SELECT display_name AS displayName FROM users WHERE id=?").get(recipientId);
    return sendJson(res, 201, { id, createdAt: time, expiresAt: time + MESSAGE_LIFETIME, recipient: { userId: recipientId, displayName: recipient?.displayName || null } });
  }

  if (method === "POST" && url.pathname === "/chet/chat/api/blocks") {
    const blockedId = String(body.userId || "").toUpperCase();
    if (blockedId === user.id || !db.prepare("SELECT 1 FROM users WHERE id=?").get(blockedId)) throw apiError(400, "Invalid user ID.");
    db.prepare("INSERT OR IGNORE INTO blocks(user_id,blocked_id,created_at) VALUES(?,?,?)").run(user.id, blockedId, now());
    return sendJson(res, 201, { blocked: blockedId });
  }

  const blockMatch = url.pathname.match(/^\/chet\/chat\/api\/blocks\/([^/]+)$/);
  if (method === "DELETE" && blockMatch) {
    db.prepare("DELETE FROM blocks WHERE user_id=? AND blocked_id=?").run(user.id, decodeURIComponent(blockMatch[1]).toUpperCase());
    return sendJson(res, 200, { unblocked: true });
  }

  const imageMatch = url.pathname.match(/^\/chet\/chat\/api\/images\/([a-f0-9-]+\.jpg)$/);
  if (method === "GET" && imageMatch) {
    const filename = path.basename(imageMatch[1]);
    let allowed = false;
    const personal = db.prepare("SELECT 1 FROM personal_messages WHERE image_file=? AND expires_at>? AND (sender_id=? OR recipient_id=?)").get(filename, now(), user.id, user.id);
    if (personal) allowed = true;
    if (!allowed) {
      const chatMessage = db.prepare("SELECT chat_id FROM chat_messages WHERE image_file=? AND expires_at>?").get(filename, now());
      if (chatMessage) {
        const token = body._auth?.chatToken || req.headers["x-chat-token"];
        const chat = db.prepare("SELECT credential_version FROM chats WHERE id=?").get(chatMessage.chat_id);
        const member = db.prepare("SELECT * FROM memberships WHERE chat_id=? AND user_id=?").get(chatMessage.chat_id, user.id);
        allowed = !!(chat && member && typeof token === "string" && safeEqual(hash(token), member.token_hash) && member.credential_version === chat.credential_version);
      }
    }
    if (!allowed) throw apiError(403, "Image access denied.");
    const filePath = path.join(IMAGE_DIR, filename);
    if (!fs.existsSync(filePath)) throw apiError(404, "Image not found.");
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": fs.statSync(filePath).size, "Cache-Control": "private, max-age=300" });
    return fs.createReadStream(filePath).pipe(res);
  }

  throw apiError(404, "Not found.");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error(error.status ? `${error.status} ${error.message}` : error);
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error.status ? error.message : "Internal server error.", ...(error.extra || {}) });
    else res.end();
  });
});

setInterval(cleanup, 60000).unref();
cleanup();
scheduleExpiryCleanup();
server.listen(PORT, HOST, () => console.log(`Pugmoog chat listening on http://${HOST}:${PORT}`));
