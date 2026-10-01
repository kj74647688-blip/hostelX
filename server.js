const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "hostelx-data.json");
const sessions = new Map();

function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  const digest = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${digest}`;
}

function passwordMatches(password, stored) {
  if (typeof stored !== "string") return false;
  const [salt, expectedHex] = stored.split(":");
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function saveData() {
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data));
  fs.renameSync(temp, DATA_FILE);
}

function loadData() {
  if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const initial = { users: [], chats: [], messages: [], nextChatId: 1 };
  for (let id = 1; id <= 50; id++) {
    initial.users.push({
      id,
      login: `user${id}.hostelx.in`,
      passwordHash: passwordHash(`user${id}`),
      name: id === 1 ? "HostelX Admin" : "",
      firstLogin: id !== 1,
      role: id === 1 ? "admin" : "user"
    });
  }
  data = initial;
  saveData();
  return initial;
}

let data;
data = loadData();

function publicUser(user) {
  return { id: user.id, login: user.login, name: user.name, firstLogin: user.firstLogin, role: user.role };
}

function sendJson(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error("Request is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON.")); }
    });
    req.on("error", reject);
  });
}

function getSession(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)hostelx_session=([a-f0-9]+)/);
  return match ? sessions.get(match[1]) : null;
}

function requireUser(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "Please log in again." });
    return null;
  }
  const user = data.users.find(item => item.id === session.userId);
  if (!user) {
    sendJson(res, 401, { error: "Account not found." });
    return null;
  }
  return { session, user };
}

function safeText(value, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method;

  if (route === "/api/login" && method === "POST") {
    const body = await readBody(req);
    const login = safeText(body.login, 100).toLowerCase();
    const user = data.users.find(item => item.login === login);
    if (!user || !passwordMatches(String(body.password || ""), user.passwordHash)) {
      return sendJson(res, 401, { error: "Invalid login ID or password." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { userId: user.id, openedChats: new Set() });
    return sendJson(res, 200, { user: publicUser(user) }, {
      "Set-Cookie": `hostelx_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`
    });
  }

  if (route === "/api/logout" && method === "POST") {
    const cookie = req.headers.cookie || "";
    const match = cookie.match(/(?:^|;\s*)hostelx_session=([a-f0-9]+)/);
    if (match) sessions.delete(match[1]);
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": "hostelx_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
  }

  const auth = requireUser(req, res);
  if (!auth) return;
  const { user, session } = auth;

  if (route === "/api/session" && method === "GET") return sendJson(res, 200, { user: publicUser(user) });

  if (route === "/api/setup" && method === "POST") {
    if (!user.firstLogin) return sendJson(res, 400, { error: "Account setup is already complete." });
    const body = await readBody(req);
    const name = safeText(body.name, 30);
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[a-zA-Z0-9_]{2,30}$/.test(name)) return sendJson(res, 400, { error: "Use 2–30 letters, numbers or underscores for your name." });
    if (password.length < 8 || password.length > 200) return sendJson(res, 400, { error: "Password must be 8–200 characters." });
    const login = `${name.toLowerCase()}.hostelx.in`;
    if (data.users.some(item => item.login === login && item.id !== user.id)) return sendJson(res, 400, { error: "This login name is already taken." });
    user.name = name;
    user.login = login;
    user.passwordHash = passwordHash(password);
    user.firstLogin = false;
    saveData();
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (route === "/api/users" && method === "GET") {
    if (user.role !== "admin") return sendJson(res, 403, { error: "Admin access only." });
    return sendJson(res, 200, { users: data.users.map(publicUser) });
  }

  if (route === "/api/chats" && method === "GET") {
    const chats = data.chats.filter(chat => chat.memberIds.includes(user.id)).map(({ id, name, memberIds }) => ({ id, name, memberIds }));
    return sendJson(res, 200, { chats });
  }

  if (route === "/api/chats" && method === "POST") {
    if (user.role !== "admin") return sendJson(res, 403, { error: "Admin access only." });
    const body = await readBody(req);
    const name = safeText(body.name, 80);
    const password = typeof body.password === "string" ? body.password : "";
    const memberIds = Array.isArray(body.memberIds) ? body.memberIds.map(Number).filter(id => data.users.some(item => item.id === id)) : [];
    if (name.length < 2) return sendJson(res, 400, { error: "Enter a group name (at least 2 characters)." });
    if (password.length < 6 || password.length > 200) return sendJson(res, 400, { error: "Group password must be at least 6 characters." });
    if (!memberIds.length) return sendJson(res, 400, { error: "Select at least one user." });
    memberIds.push(user.id);
    const chat = { id: data.nextChatId++, name, passwordHash: passwordHash(password), memberIds: [...new Set(memberIds)] };
    data.chats.push(chat);
    saveData();
    return sendJson(res, 201, { chat: { id: chat.id, name: chat.name, memberIds: chat.memberIds } });
  }

  const chatMatch = route.match(/^\/api\/chats\/(\d+)(?:\/(open|messages))?$/);
  if (chatMatch) {
    const chatId = Number(chatMatch[1]);
    const action = chatMatch[2];
    const chat = data.chats.find(item => item.id === chatId);
    if (!chat || !chat.memberIds.includes(user.id)) return sendJson(res, 403, { error: "Chat access denied." });

    if (action === "open" && method === "POST") {
      const body = await readBody(req);
      if (!passwordMatches(String(body.password || ""), chat.passwordHash)) return sendJson(res, 401, { error: "Incorrect group password." });
      session.openedChats.add(chatId);
      return sendJson(res, 200, { ok: true });
    }

    if (action === "messages" && session.openedChats.has(chatId)) {
      if (method === "GET") {
        const messages = data.messages.filter(message => message.chatId === chatId);
        return sendJson(res, 200, { messages });
      }
      if (method === "POST") {
        const body = await readBody(req);
        const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
        const image = typeof body.image === "string" ? body.image : "";
        const validImage = !image || (/^data:image\/(png|jpeg|webp|gif);base64,/.test(image) && image.length <= 4 * 1024 * 1024 + 100);
        if (!text && !image) return sendJson(res, 400, { error: "Write a message or choose a photo." });
        if (!validImage) return sendJson(res, 400, { error: "Photo must be PNG, JPG, GIF or WebP and under 3 MB." });
        const message = {
          chatId,
          sender: user.name || user.login,
          text,
          image,
          time: new Date().toISOString()
        };
        data.messages.push(message);
        saveData();
        return sendJson(res, 201, { message });
      }
    }
    return sendJson(res, 403, { error: "Open this chat with its password first." });
  }

  return sendJson(res, 404, { error: "Not found." });
}

const mimeTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon" };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = path.resolve(__dirname, `.${requested}`);
    if (!file.startsWith(`${__dirname}${path.sep}`)) return sendJson(res, 404, { error: "Not found." });
    fs.readFile(file, (error, content) => {
      if (error) return sendJson(res, 404, { error: "File not found." });
      res.writeHead(200, { "Content-Type": mimeTypes[path.extname(file)] || "application/octet-stream", "X-Content-Type-Options": "nosniff" });
      res.end(content);
    });
  } catch (error) {
    if (!res.headersSent) sendJson(res, 400, { error: error.message || "Request failed." });
    else res.destroy();
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`HostelX server listening on port ${PORT}`));
