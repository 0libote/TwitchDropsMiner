const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
let state = null;
let filter = "all";
let settingsLoaded = false;
let priorityGames = [];
let excludedGames = [];

function formatMinutes(minutes) {
  if (minutes == null) return "—";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours ? `${hours}h ${mins}m remaining` : `${mins}m remaining`;
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  setTimeout(() => node.classList.remove("show"), 2200);
}

async function request(url, options = {}) {
  const response = await fetch(url, {headers: {"Content-Type": "application/json"}, ...options});
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function render(next) {
  state = next;
  $("#connection-dot").classList.add("live");
  $("#connection-label").textContent = "Live";
  $("#status").textContent = next.status || "Running";

  const drop = next.activeDrop;
  $("#drop-title").textContent = drop?.rewards || "Waiting for the next eligible drop";
  $("#drop-meta").textContent = drop ? `${drop.name} · ${drop.currentMinutes}/${drop.requiredMinutes} minutes` : "The miner will select the best eligible campaign.";
  $("#drop-progress").style.width = `${(drop?.progress || 0) * 100}%`;
  $("#drop-percent").textContent = `${Math.round((drop?.progress || 0) * 100)}%`;
  $("#drop-remaining").textContent = drop ? formatMinutes(drop.remainingMinutes) : "—";

  $("#metric-active").textContent = next.summary.activeCampaigns;
  $("#metric-total").textContent = `${next.summary.campaigns} discovered`;
  $("#metric-completed").textContent = next.summary.completedCampaigns;
  $("#metric-channels").textContent = next.summary.onlineChannels;
  $("#metric-sockets").textContent = next.websockets.length || "—";

  const login = next.login || {};
  const needsActivation = Boolean(login.activationCode && !login.userId);
  $("#login-callout").classList.toggle("hidden", !needsActivation);
  if (needsActivation) {
    $("#activation-code").textContent = login.activationCode;
    $("#activation-link").href = login.activationUrl;
  }
  $("#logout-button").disabled = !next.canLogout;
  $("#refresh-button").disabled = !next.canLogout;
  const idle = next.activity === "idle";
  $("#pause-button").disabled = !next.canLogout;
  $("#pause-button").textContent = idle ? "Resume" : "Pause";
  $("#pause-button").dataset.action = idle ? "reload" : "pause";
  $("#game-options").innerHTML = next.games.map(game => `<option value="${esc(game)}"></option>`).join("");

  renderCampaigns();
  renderChannels();
  renderLog();
  if (!settingsLoaded) loadSettings();
}

function renderCampaigns() {
  if (!state) return;
  const campaigns = state.campaigns.filter(c => filter === "all" || (filter === "finished" ? c.finished : c.status === filter));
  $("#campaign-grid").innerHTML = campaigns.length ? campaigns.map(c => `
    <article class="campaign">
      <div class="campaign-head">
        <img src="${esc(c.image)}" alt="" loading="lazy">
        <div><span class="badge ${esc(c.status)}">${esc(c.finished ? "finished" : c.status)}</span><h3>${esc(c.name)}</h3><div class="game">${esc(c.game)}</div></div>
      </div>
      <div class="campaign-foot">
        <div class="row"><span>${c.claimedDrops}/${c.totalDrops} drops</span><span>${Math.round(c.progress * 100)}%</span></div>
        <div class="mini-track"><span style="width:${c.progress * 100}%"></span></div>
      </div>
    </article>`).join("") : `<div class="empty">No ${esc(filter === "all" ? "" : filter)} campaigns to show.</div>`;
}

function renderChannels() {
  const channels = state.channels;
  $("#channel-count").textContent = `${channels.length} available`;
  $("#channel-table").innerHTML = channels.length ? channels.map(c => `
    <tr>
      <td><strong>${esc(c.name)}</strong>${c.watching ? ' <span class="badge">watching</span>' : ""}<br><small class="muted">${esc(c.title || "Offline")}</small></td>
      <td>${esc(c.game || "—")}</td>
      <td>${c.viewers == null ? "—" : Number(c.viewers).toLocaleString()}</td>
      <td><span class="${c.dropsEnabled ? "live" : "muted"}">${c.dropsEnabled ? "Enabled" : "Unavailable"}</span></td>
      <td><button class="button ghost watch" data-channel="${c.id}" ${!c.online || c.watching ? "disabled" : ""}>${c.watching ? "Watching" : "Switch"}</button></td>
    </tr>`).join("") : `<tr><td colspan="5" class="empty">No eligible channels yet.</td></tr>`;
  $$(".watch").forEach(button => button.addEventListener("click", () => run(`/api/channels/${button.dataset.channel}`, {method: "POST"}, "Switch requested")));
}

function renderLog() {
  const lines = [...state.messages].reverse();
  $("#activity-log").innerHTML = lines.length ? lines.map(line => `<p>${esc(line)}</p>`).join("") : "<p>Waiting for miner events…</p>";
}

function loadSettings() {
  const form = $("#settings-form");
  const values = state.settings;
  form.elements.priorityMode.value = values.priorityMode;
  form.elements.connectionQuality.value = values.connectionQuality;
  form.elements.enableBadgesEmotes.checked = values.enableBadgesEmotes;
  form.elements.availableDropsCheck.checked = values.availableDropsCheck;
  priorityGames = [...values.priority];
  excludedGames = [...values.exclude];
  renderGameSettings();
  settingsLoaded = true;
}

function renderGameSettings() {
  const row = (game, index, list) => `<div class="game-item"><span>${esc(game)}</span><span class="controls">
    ${list === "priority" ? `<button type="button" data-game-action="up" data-game-list="${list}" data-game-index="${index}" ${index === 0 ? "disabled" : ""} aria-label="Move ${esc(game)} up">↑</button><button type="button" data-game-action="down" data-game-list="${list}" data-game-index="${index}" ${index === priorityGames.length - 1 ? "disabled" : ""} aria-label="Move ${esc(game)} down">↓</button>` : ""}
    <button type="button" data-game-action="remove" data-game-list="${list}" data-game-index="${index}" aria-label="Remove ${esc(game)}">×</button>
  </span></div>`;
  $("#priority-list").innerHTML = priorityGames.map((game, index) => row(game, index, "priority")).join("");
  $("#exclude-list").innerHTML = excludedGames.map((game, index) => row(game, index, "exclude")).join("");
}

function addGame(list) {
  const input = $(`#${list}-game`);
  const value = input.value.trim();
  const target = list === "priority" ? priorityGames : excludedGames;
  if (value && !target.includes(value)) target.push(value);
  input.value = "";
  renderGameSettings();
}

async function run(url, options, success) {
  try { await request(url, options); toast(success); }
  catch (error) { toast(error.message || "Request failed"); }
}

$$('[data-action]').forEach(button => button.addEventListener("click", () => run(`/api/actions/${button.dataset.action}`, {method: "POST"}, "Request accepted")));
$$('[data-filter]').forEach(button => button.addEventListener("click", () => {
  filter = button.dataset.filter;
  $$('[data-filter]').forEach(item => item.classList.toggle("active", item === button));
  renderCampaigns();
}));
$("#save-settings").addEventListener("click", async () => {
  const form = $("#settings-form");
  await run("/api/settings", {method: "PUT", body: JSON.stringify({
    priorityMode: form.elements.priorityMode.value,
    connectionQuality: Number(form.elements.connectionQuality.value),
    priority: priorityGames,
    exclude: excludedGames,
    enableBadgesEmotes: form.elements.enableBadgesEmotes.checked,
    availableDropsCheck: form.elements.availableDropsCheck.checked,
  })}, "Settings saved");
});
$$('[data-add-game]').forEach(button => button.addEventListener("click", () => addGame(button.dataset.addGame)));
[$("#priority-game"), $("#exclude-game")].forEach(input => input.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); addGame(input.id.split("-")[0]); }
}));
$("#settings-form").addEventListener("click", event => {
  const button = event.target.closest("[data-game-action]");
  if (!button) return;
  const target = button.dataset.gameList === "priority" ? priorityGames : excludedGames;
  const index = Number(button.dataset.gameIndex);
  if (button.dataset.gameAction === "remove") target.splice(index, 1);
  if (button.dataset.gameAction === "up" && index > 0) [target[index - 1], target[index]] = [target[index], target[index - 1]];
  if (button.dataset.gameAction === "down" && index < target.length - 1) [target[index + 1], target[index]] = [target[index], target[index + 1]];
  renderGameSettings();
});

const events = new EventSource("/api/events");
events.onmessage = event => render(JSON.parse(event.data));
events.onerror = () => {
  $("#connection-dot").classList.remove("live");
  $("#connection-label").textContent = "Reconnecting";
};

const navLinks = $$('nav a');
const sectionObserver = new IntersectionObserver(entries => {
  const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
  if (!visible) return;
  navLinks.forEach(link => link.classList.toggle("active", link.hash === `#${visible.target.id}`));
}, {rootMargin: "-15% 0px -65% 0px", threshold: [0, .25, .5]});
$$('main > section').forEach(section => sectionObserver.observe(section));
