let currentUser = null;
let selectedChat = null;
let pollTimer = null;
let knownMessageCount = -1;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin"
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "The request could not be completed.");
  return result;
}

function showPage(pageId) {
  ["loginPage", "setupPage", "appPage"].forEach(id => document.getElementById(id).classList.add("hidden"));
  document.getElementById(pageId).classList.remove("hidden");
}

async function login() {
  const error = document.getElementById("loginError");
  error.textContent = "";
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        login: document.getElementById("loginId").value.trim().toLowerCase(),
        password: document.getElementById("loginPassword").value
      })
    });
    currentUser = result.user;
    if (currentUser.firstLogin) showPage("setupPage");
    else await enterApp();
  } catch (err) {
    error.textContent = err.message;
  }
}

async function saveAccount() {
  const error = document.getElementById("setupError");
  error.textContent = "";
  try {
    const result = await api("/api/setup", {
      method: "POST",
      body: JSON.stringify({
        name: document.getElementById("displayName").value.trim(),
        password: document.getElementById("newPassword").value
      })
    });
    currentUser = result.user;
    await enterApp();
  } catch (err) {
    error.textContent = err.message;
  }
}

async function enterApp() {
  showPage("appPage");
  document.getElementById("welcome").textContent = `Welcome, ${currentUser.name || currentUser.login} (${currentUser.login})`;
  if (currentUser.role === "admin") {
    document.getElementById("adminPanel").classList.remove("hidden");
    await renderUsers();
  }
  await renderChats();
}

async function renderUsers() {
  const { users } = await api("/api/users");
  const userList = document.getElementById("userList");
  const memberList = document.getElementById("memberList");
  userList.replaceChildren();
  memberList.replaceChildren();
  users.forEach(user => {
    const div = document.createElement("div");
    div.className = "user";
    div.textContent = `${user.name || "Name not set"} — ${user.login} ${user.role === "admin" ? "(Admin)" : ""}`;
    userList.appendChild(div);
    if (user.id !== currentUser.id) {
      const label = document.createElement("label");
      label.className = "user";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = user.id;
      checkbox.style.width = "auto";
      label.append(checkbox, document.createTextNode(" " + (user.name || user.login)));
      memberList.appendChild(label);
    }
  });
}

async function createGroup() {
  const message = document.getElementById("adminMessage");
  message.textContent = "";
  try {
    const memberIds = [...document.querySelectorAll("#memberList input:checked")].map(input => Number(input.value));
    await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({
        name: document.getElementById("groupName").value.trim(),
        password: document.getElementById("groupPassword").value,
        memberIds
      })
    });
    document.getElementById("groupName").value = "";
    document.getElementById("groupPassword").value = "";
    document.querySelectorAll("#memberList input").forEach(box => { box.checked = false; });
    message.textContent = "Group created.";
    message.className = "success";
    await renderChats();
  } catch (err) {
    message.textContent = err.message;
    message.className = "error";
  }
}

async function renderChats() {
  const list = document.getElementById("chatList");
  list.replaceChildren();
  try {
    const { chats } = await api("/api/chats");
    if (!chats.length) {
      list.textContent = "No chats assigned to you yet.";
      return;
    }
    chats.forEach(chat => {
      const button = document.createElement("button");
      button.className = "secondary chat-button";
      button.textContent = chat.name;
      button.onclick = () => selectChat(chat);
      list.appendChild(button);
    });
  } catch (err) {
    list.textContent = err.message;
  }
}

function selectChat(chat) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  selectedChat = chat;
  knownMessageCount = -1;
  document.getElementById("chatTitle").textContent = chat.name;
  document.getElementById("chatPassword").value = "";
  document.getElementById("chatError").textContent = "";
  document.getElementById("messageError").textContent = "";
  document.getElementById("passwordPanel").classList.remove("hidden");
  document.getElementById("chatRoom").classList.add("hidden");
}

async function openChat() {
  if (!selectedChat) return;
  const error = document.getElementById("chatError");
  error.textContent = "";
  try {
    await api(`/api/chats/${selectedChat.id}/open`, {
      method: "POST",
      body: JSON.stringify({ password: document.getElementById("chatPassword").value })
    });
    document.getElementById("passwordPanel").classList.add("hidden");
    document.getElementById("chatRoom").classList.remove("hidden");
    await renderMessages();
    pollTimer = setInterval(renderMessages, 2500);
  } catch (err) {
    error.textContent = err.message;
  }
}

async function renderMessages() {
  if (!selectedChat || document.getElementById("chatRoom").classList.contains("hidden")) return;
  try {
    const { messages } = await api(`/api/chats/${selectedChat.id}/messages`);
    if (messages.length === knownMessageCount) return;
    const area = document.getElementById("messages");
    const wasNearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
    area.replaceChildren();
    messages.forEach(addMessageToScreen);
    if (wasNearBottom || knownMessageCount === -1) area.scrollTop = area.scrollHeight;
    knownMessageCount = messages.length;
  } catch (err) {
    document.getElementById("messageError").textContent = err.message;
  }
}

function addMessageToScreen(message) {
  const area = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "message";
  const sender = document.createElement("strong");
  sender.textContent = `${message.sender}: `;
  div.appendChild(sender);
  if (message.text) {
    const body = document.createElement("span");
    body.textContent = message.text;
    div.appendChild(body);
  }
  if (message.image) {
    const image = document.createElement("img");
    image.src = message.image;
    image.alt = "Photo shared in chat";
    image.loading = "lazy";
    div.appendChild(image);
  }
  const time = document.createElement("small");
  time.className = "muted";
  const date = new Date(message.time);
  time.textContent = `  ${Number.isNaN(date.getTime()) ? "" : date.toLocaleString()}`;
  div.appendChild(document.createElement("br"));
  div.appendChild(time);
  area.appendChild(div);
}

function readPhoto(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve("");
    const allowed = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    if (!allowed.includes(file.type)) return reject(new Error("Choose a PNG, JPG, GIF or WebP photo."));
    if (file.size > 3 * 1024 * 1024) return reject(new Error("Photo must be under 3 MB."));
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read that photo."));
    reader.readAsDataURL(file);
  });
}

async function sendMessage() {
  if (!selectedChat) return;
  const input = document.getElementById("messageInput");
  const photoInput = document.getElementById("photoInput");
  const error = document.getElementById("messageError");
  error.textContent = "";
  try {
    const image = await readPhoto(photoInput.files[0]);
    const result = await api(`/api/chats/${selectedChat.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: input.value.trim(), image })
    });
    input.value = "";
    photoInput.value = "";
    const area = document.getElementById("messages");
    addMessageToScreen(result.message);
    knownMessageCount += 1;
    area.scrollTop = area.scrollHeight;
  } catch (err) {
    error.textContent = err.message;
  }
}

async function logout() {
  if (pollTimer) clearInterval(pollTimer);
  try { await api("/api/logout", { method: "POST", body: "{}" }); } catch (_) {}
  location.reload();
}

(async function restoreSession() {
  try {
    const result = await api("/api/session");
    currentUser = result.user;
    if (currentUser.firstLogin) showPage("setupPage");
    else await enterApp();
  } catch (_) {
    showPage("loginPage");
  }
})();
