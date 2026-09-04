const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));

let state = null;
let activeRoute = null;
let connected = false;
let toastTimer = null;
let campaignFilter = "available";
let campaignQuery = "";
let settingsDraft = null;
let settingsDirty = false;
let currentPath = location.pathname;

const routeMeta = {
  dashboard: ["Your drops, at a glance", "Overview"],
  campaigns: ["Discover rewards and track your collection", "Campaigns"],
  campaign: ["Campaign", "Campaign details"],
  mining: ["Choose what to watch next", "Mining plan"],
  settings: ["Make this miner your own", "Settings"],
  history: ["Saved rewards across your Twitch campaigns", "Reward history"],
  diagnostics: ["Connection health and miner events", "Diagnostics"],
};

const icons = {
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9M12 8v13M12 8H8a3 3 0 1 1 3-3l1 3Zm0 0h4a3 3 0 1 0-3-3l-1 3Z"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};
const icon = name => `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.gift}</svg>`;
const percent = progress => Math.round(Math.min(1, Math.max(0, Number(progress) || 0)) * 100);
const renderedContent = new WeakMap();
function setContent(selector, html) {
  const element = $(selector);
  if (!element || renderedContent.get(element) === html) return;
  const focused = document.activeElement !== element && element.contains(document.activeElement) ? document.activeElement : null;
  if (focused?.matches("input, textarea, select, [contenteditable], button:disabled")) return;
  const controls = focused ? $$("a, button, input, select, textarea, [tabindex]", element) : [];
  const index = controls.indexOf(focused);
  const identity = node => JSON.stringify([node.tagName, node.id, node.getAttribute("href"), {...node.dataset}]);
  const key = focused ? identity(focused) : null;
  renderedContent.set(element, html);
  element.innerHTML = html;
  if (focused) {
    const replacements = $$("a, button, input, select, textarea, [tabindex]", element);
    const replacement = replacements.find(node => identity(node) === key) || replacements[index] || element;
    replacement.focus({preventScroll: true});
  }
}
function artwork(src, className = "", alt = "") {
  return `<span class="artwork ${className}">${icon("gift")}${src ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy">` : ""}</span>`;
}

function routeFromPath(path = location.pathname) {
  const detail = path.match(/^\/campaigns\/([^/]+)$/);
  if (detail) return {name: "campaign", id: decodeURIComponent(detail[1])};
  return {name: ({"/":"dashboard", "/campaigns":"campaigns", "/mining":"mining", "/settings":"settings", "/diagnostics":"diagnostics", "/history":"history"})[path] || "dashboard"};
}

function formatMinutes(minutes) {
  if (minutes == null) return "—";
  const hours = Math.floor(minutes / 60);
  const mins = Math.max(0, minutes % 60);
  return hours ? `${hours}h ${mins}m remaining` : `${mins}m remaining`;
}

function formatDate(value, relative = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (relative) {
    const minutes = Math.round((date - Date.now()) / 60000);
    const absolute = Math.abs(minutes);
    if (absolute < 60) return `${absolute}m ${minutes >= 0 ? "from now" : "ago"}`;
    const hours = Math.round(absolute / 60);
    if (hours < 48) return `${hours}h ${minutes >= 0 ? "from now" : "ago"}`;
    const days = Math.round(hours / 24);
    return `${days}d ${minutes >= 0 ? "from now" : "ago"}`;
  }
  return new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(date);
}

function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [days && `${days}d`, hours && `${hours}h`, `${minutes}m`].filter(Boolean).join(" ");
}

function toast(message, error = false) {
  const node = $("#toast");
  clearTimeout(toastTimer);
  node.textContent = message;
  node.classList.toggle("error", error);
  node.classList.add("show");
  toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
}

let csrfTokenPromise;
async function request(url, options = {}) {
  const headers = {"Content-Type": "application/json", ...options.headers};
  if (!["GET", "HEAD"].includes((options.method || "GET").toUpperCase())) {
    csrfTokenPromise ||= fetch("/api/csrf").then(response => {
      if (!response.ok) throw new Error("Could not secure this request. Refresh and try again.");
      return response.json();
    }).then(data => data.token).catch(error => { csrfTokenPromise = null; throw error; });
    headers["X-CSRF-Token"] = await csrfTokenPromise;
  }
  const response = await fetch(url, {...options, headers});
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function cloneSettings(values) {
  return {
    priority: [...values.priority],
    exclude: [...values.exclude],
    priorityMode: values.priorityMode,
    connectionQuality: values.connectionQuality,
    trayNotifications: values.trayNotifications,
    enableBadgesEmotes: values.enableBadgesEmotes,
    availableDropsCheck: values.availableDropsCheck,
    autostart: values.autostart,
    keepAwake: values.keepAwake,
    proxy: values.proxy,
    webhookUrl: values.webhookUrl || "",
  };
}

function syncSettingsDraft(force = false) {
  if (!state || settingsDirty && !force) return;
  settingsDraft = cloneSettings(state.settings);
  settingsDirty = false;
}

async function saveSettings(values = settingsDraft, message = "Settings saved") {
  try {
    await request("/api/settings", {method: "PUT", body: JSON.stringify(values)});
    settingsDraft = cloneSettings(values);
    state.settings = cloneSettings(values);
    settingsDirty = false;
    toast(message);
    renderRoute(true);
    return true;
  } catch (error) {
    toast(error.message || "Unable to save settings", true);
    return false;
  }
}

async function updateGamePreference(game, mode) {
  const values = cloneSettings(state.settings);
  values.priority = values.priority.filter(item => item !== game);
  values.exclude = values.exclude.filter(item => item !== game);
  if (mode === "priority") values.priority.unshift(game);
  if (mode === "exclude") values.exclude.push(game);
  await saveSettings(values, mode === "priority" ? `${game} moved to the front` : `${game} excluded`);
}

function activeCampaign() {
  const dropId = state?.activeDrop?.id;
  return dropId ? state.campaigns.find(campaign => campaign.drops.some(drop => drop.id === dropId)) : null;
}

function activeChannel() {
  return state?.channels.find(channel => channel.watching) || null;
}

function statusKind() {
  if (!connected) return "error";
  if (state?.activity === "error") return "error";
  if (["active", "pickaxe"].includes(state?.activity)) return "live";
  return "working";
}

function showApplication() {
  const login = state.login || {};
  const needsActivation = Boolean(login.activationCode && !login.userId);
  if (!needsActivation && !login.userId && !state.canLogout) {
    $("#loading").classList.remove("hidden");
    $("#auth-view").classList.add("hidden");
    $("#app-shell").classList.add("hidden");
    return;
  }
  $("#loading").classList.add("hidden");
  $("#auth-view").classList.toggle("hidden", !needsActivation);
  $("#app-shell").classList.toggle("hidden", needsActivation);
  if (needsActivation) {
    $("#activation-code").textContent = login.activationCode;
    $("#activation-link").href = login.activationUrl;
    $("#auth-status").textContent = state.status || "Waiting for authorization";
    return;
  }
  updateChrome();
  renderRoute();
}

function updateChrome() {
  const route = routeFromPath();
  const navName = route.name === "campaign" ? "campaigns" : route.name;
  $$('[data-nav]').forEach(link => {
    if (link.dataset.nav === navName) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const [kicker, title] = routeMeta[route.name];
  $("#page-kicker").textContent = kicker;
  $("#page-title").textContent = route.name === "campaign" ? state.campaigns.find(item => item.id === route.id)?.game || title : title;
  document.title = `${$("#page-title").textContent} · Twitch Drops Miner`;

  const kind = statusKind();
  $("#connection-dot").className = `status-dot ${kind}`;
  $("#connection-label").textContent = connected ? (state.paused === true ? "Miner paused" : "Miner connected") : "Reconnecting";
  $("#connection-detail").textContent = connected ? state.status || "Waiting for updates" : "Showing last received state";
  $("#sidebar-version").textContent = state.system?.version ? `Next · ${state.system.version}` : "Twitch Drops Miner Next";
  $("#campaign-count").textContent = state.campaigns.filter(item => item.status === "active" && item.eligible && !item.finished).length;
  $("#connection-banner").classList.toggle("hidden", connected);

  const issues = state.networkIssues || [];
  const alert = $("#network-alert");
  alert.classList.toggle("hidden", !issues.length);
  setContent("#network-alert", issues.length ? `<div><strong>Twitch service blocked or unreachable</strong><p>Requests to ${esc(issues.join(", "))} are failing. Drop progress may stop.</p></div><a href="https://github.com/0libote/TwitchDropsMiner#dns-blockers-and-firewalls" target="_blank" rel="noreferrer">Troubleshoot</a>` : "");

  const controls = [];
  if (route.name === "dashboard") {
    const idle = state.paused === true;
    controls.push(`<button class="button secondary" data-action="${idle ? "resume" : "pause"}" ${state.canLogout ? "" : "disabled"}>${icon(idle ? "play" : "pause")}${idle ? "Resume mining" : "Pause mining"}</button>`);
    controls.push(`<button class="button secondary" data-action="reload" ${state.canLogout ? "" : "disabled"}>${icon("refresh")}Refresh</button>`);
  } else if (route.name === "campaigns") {
    controls.push(`<button class="button secondary" data-action="reload" ${state.canLogout ? "" : "disabled"}>Refresh inventory</button>`);
  }
  setContent("#topbar-actions", controls.join(""));
}

function dashboardTemplate() {
  return `
    <div class="dashboard-grid">
      <section class="now-card" aria-labelledby="now-heading">
        <div class="now-body" id="now-body"></div>
        <div id="reward-track"></div>
      </section>
      <aside class="session-panel" aria-labelledby="watching-heading">
        <div class="section-title"><h2 id="watching-heading">This session</h2><a class="text-link" href="/diagnostics" data-route>Details ${icon("arrow")}</a></div>
        <div id="session-facts"></div>
        <dl class="session-stats" id="stat-cards" aria-label="Session statistics"></dl>
      </aside>
    </div>
    <div class="dashboard-lower">
      <section aria-labelledby="queue-heading">
        <div class="section-title"><div><h2 id="queue-heading">Your mining plan</h2><p>Game selection order and availability.</p></div><a class="text-link" href="/mining" data-route>Edit queue ${icon("arrow")}</a></div>
        <div class="queue-preview" id="queue-preview"></div>
        <div class="queue-footnote" id="queue-rule"></div>
      </section>
      <section aria-labelledby="activity-heading">
        <div class="section-title"><h2 id="activity-heading">Recent activity</h2><a class="text-link" href="/diagnostics" data-route>All activity ${icon("arrow")}</a></div>
        <div class="activity-preview" id="activity-preview"></div>
      </section>
    </div>`;
}

function updateDashboard() {
  const drop = state.activeDrop;
  const campaign = activeCampaign();
  const channel = activeChannel();
  const paused = state.paused === true;
  const mining = connected && !paused && ["active", "pickaxe"].includes(state.activity);
  const heading = paused ? "Mining is paused" : drop?.rewards || "Ready for the next drop";
  const explanation = paused ? "Your progress is saved. Resume whenever you’re ready." : drop ? drop.name : "Waiting for an eligible campaign and a live channel. The miner will keep checking.";
  const progress = percent(drop?.progress);
  setContent("#now-body", `
    <div class="now-status"><span class="state-label"><span class="status-dot ${statusKind()}"></span>${!connected ? "Connection interrupted" : paused ? "Paused" : state.activity === "error" ? "Miner needs attention" : mining && drop ? "Currently mining" : "Waiting for drops"}</span>${campaign ? `<a class="text-link" href="/campaigns/${encodeURIComponent(campaign.id)}" data-route>View campaign ${icon("arrow")}</a>` : ""}</div>
    <div class="reward-stage">
      ${artwork(drop?.benefits?.[0]?.image, "reward-art", drop?.rewards || "")}
      <div class="reward-copy">
        ${campaign ? `<p class="reward-game">${esc(campaign.game)}</p>` : ""}
        <h2 id="now-heading">${esc(heading)}</h2>
        <p class="now-meta">${esc(explanation)}</p><p class="progress-health">${state.progressHealth?.lastConfirmedAt ? `Last confirmed progress ${esc(formatDate(state.progressHealth.lastConfirmedAt, true))}. ` : "No confirmed progress yet. "}${esc(state.progressHealth?.recoveryReason || "")}${state.progressHealth?.nextRecoveryInSeconds != null ? ` Next recovery check in ${Math.ceil(state.progressHealth.nextRecoveryInSeconds / 60)} min.` : ""}</p>
        ${drop ? `<div class="reward-progress-label"><strong>${progress}<span>%</span></strong><span>${esc(formatMinutes(drop.remainingMinutes))}</span></div>
        <div class="progress" role="progressbar" aria-label="Current drop progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div>
        <div class="progress-meta"><span>${esc(drop.currentMinutes)} of ${esc(drop.requiredMinutes)} minutes watched</span><span>${!connected || paused ? "Progress saved" : "Claims automatically"}</span></div>` : `<a class="button secondary" href="/campaigns" data-route>Browse campaigns ${icon("arrow")}</a>`}
      </div>
    </div>`);

  setContent("#reward-track", campaign ? `<div class="reward-track-heading"><span>Campaign rewards</span><span>${campaign.claimedDrops} of ${campaign.totalDrops} claimed</span></div><ol class="reward-track">${campaign.drops.slice(0, 4).map((reward, index) => `<li class="${reward.claimed ? "claimed" : reward.id === drop?.id ? "current" : ""}"><span class="reward-step" aria-hidden="true">${reward.claimed ? icon("check") : String(index + 1).padStart(2, "0")}</span><div><strong>${esc(reward.rewards || reward.name)}</strong><small>${reward.claimed ? "Claimed" : reward.id === drop?.id ? paused ? "Paused" : "In progress" : reward.claimable ? "Ready to claim" : `${reward.requiredMinutes} min watch time`}</small></div></li>`).join("")}</ol>${campaign.drops.length > 4 ? `<a class="text-link more-rewards" href="/campaigns/${encodeURIComponent(campaign.id)}" data-route>View all ${campaign.totalDrops} rewards ${icon("arrow")}</a>` : ""}` : "");

  setContent("#session-facts", `<div class="stream-summary"><span class="stream-avatar" aria-hidden="true">${esc(channel?.name?.slice(0, 2).toUpperCase() || "—")}</span><div><span class="muted">${mining && channel ? "Watching on Twitch" : "Selected channel"}</span><strong>${channel ? `<a class="channel-link" href="${esc(channel.url)}" target="_blank" rel="noreferrer">${esc(channel.name)} <span aria-hidden="true">↗</span></a>` : "Finding a channel"}</strong></div></div><p class="stream-title">${channel ? esc(channel.title || channel.game || "") : "Eligible live streams appear automatically."}</p>`);
  const stats = state.stats || {};
  setContent("#stat-cards", `
    <div><dt>Drops claimed</dt><dd class="claimed-total">${stats.session?.drops_claimed || 0}<small>${stats.lifetime?.drops_claimed || 0} this installation</small></dd></div>
    <div><dt>Time mining</dt><dd>${esc(formatDuration((stats.session?.mining_minutes || 0) * 60))}</dd></div>
    <div><dt>Session uptime</dt><dd>${esc(formatDuration(stats.uptimeSeconds || 0))}</dd></div>
    <div class="session-selection"><dt>Selection rule</dt><dd>${esc(({PRIORITY_ONLY:"Priority games only",ENDING_SOONEST:"Ending soonest",LOW_AVBL_FIRST:"Lowest availability"})[state.settings.priorityMode] || "Automatic")}</dd></div>`);

  const plan = state.miningPlan || state.settings.priority.map(game => ({game, reason: "Priority preference; selection details unavailable", priority: true}));
  setContent("#queue-preview", plan.length ? plan.slice(0, 5).map((item, index) => {
    const isMining = mining && item.watching;
    return `<div class="queue-row"><span class="queue-number">${String(index + 1).padStart(2, "0")}</span>${artwork(item.image, "queue-art")}<span class="queue-game">${item.campaignId ? `<a href="/campaigns/${encodeURIComponent(item.campaignId)}" data-route>${esc(item.game)}</a>` : `<strong>${esc(item.game)}</strong>`}<small>${esc(item.reason)}${item.estimatedCompletionAt ? ` · Earliest completion ${esc(formatDate(item.estimatedCompletionAt))}` : ""}</small></span><span class="queue-state ${isMining ? "" : "muted"}">${isMining ? '<span class="status-dot live"></span>Mining' : item.priority ? "Priority" : "Automatic"}</span></div>`;
  }).join("") : `<div class="empty-state"><div>${icon("gift")}<strong>No games selected for mining</strong><p>Check campaign availability, account links and your mining preferences.</p><a class="button secondary" href="/mining" data-route>Open mining plan</a></div></div>`);
  setContent("#queue-rule", `<span>${plan.length > 5 ? `${plan.length - 5} more games in your plan. ` : ""} ${state.settings.priorityMode === "PRIORITY_ONLY" ? "Only priority games will be mined." : "Automatic games follow the selection rule when priorities are unavailable."} Estimates assume uninterrupted eligible viewing; outages, pauses and prerequisites can delay completion.</span>`);

  const events = [...(state.notifications || []).map(item => ({title: item.title, text: item.message, time: item.time, notification: true})), ...(state.messages || []).slice(-8).reverse().map(item => ({title: "Miner", text: item.message || item, time: item.time}))].sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0)).slice(0, 4);
  setContent("#activity-preview", events.length ? events.map(item => `<div class="activity-row"><span class="activity-mark ${item.notification ? "notification" : ""}" aria-hidden="true">${icon(item.notification ? "gift" : "check")}</span><div><div class="activity-heading"><strong>${esc(item.title)}</strong>${item.time ? `<time datetime="${esc(item.time)}" title="${esc(formatDate(item.time))}">${esc(new Intl.DateTimeFormat(undefined, {hour: "2-digit", minute: "2-digit"}).format(new Date(item.time)))}</time>` : ""}</div><p>${esc(item.text)}</p></div></div>`).join("") : `<div class="empty-state"><div><strong>No activity yet</strong><p>Progress updates and claimed drops will appear here.</p></div></div>`);
}

function campaignBadge(campaign) {
  if (campaign.finished) return ["Completed", "good"];
  if (!campaign.linked) return ["Account link needed", "danger"];
  if (!campaign.eligible) return ["Unavailable", "danger"];
  if (campaign.status === "active") return ["Active", "good"];
  if (campaign.status === "upcoming") return ["Upcoming", "warn"];
  return ["Expired", ""];
}

function feasibility(campaign) {
  if (campaign.finished || campaign.status !== "active" || !campaign.remainingMinutes) return "";
  const available = (new Date(campaign.endsAt) - Date.now()) / 60000;
  return available < campaign.remainingMinutes ? '<div class="muted" style="margin-top:5px;font-size:11px">May not finish in time</div>' : "";
}

function campaignListTemplate() {
  return `
    <div class="campaign-toolbar">
      <label class="search"><span class="hidden">Search campaigns</span><input id="campaign-search" type="search" aria-label="Search campaigns" placeholder="Search campaigns or games" value="${esc(campaignQuery)}"></label>
      <div class="segmented" aria-label="Campaign filter">${[["available","Available"],["active","Active"],["upcoming","Upcoming"],["finished","Completed"],["all","All"]].map(([value, label]) => `<button type="button" data-campaign-filter="${value}" aria-pressed="${campaignFilter === value}">${label}</button>`).join("")}</div>
    </div>
    <div class="collection-summary" id="collection-summary"></div><section class="panel campaign-list" id="campaign-list" aria-live="polite"></section>`;
}

function filteredCampaigns() {
  const query = campaignQuery.trim().toLocaleLowerCase();
  return state.campaigns.filter(campaign => {
    const matchesQuery = !query || `${campaign.name} ${campaign.game}`.toLocaleLowerCase().includes(query);
    const matchesFilter = campaignFilter === "all"
      || campaignFilter === "available" && campaign.status === "active" && campaign.eligible && !campaign.finished
      || campaignFilter === "finished" && campaign.finished
      || campaignFilter === campaign.status;
    return matchesQuery && matchesFilter;
  }).sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || new Date(a.endsAt) - new Date(b.endsAt));
}

function updateCampaignList() {
  const campaigns = filteredCampaigns();
  $("#collection-summary").textContent = `${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"} · Ordered by end date, active first`;
  setContent("#campaign-list", campaigns.length ? campaigns.map(campaign => {
    const [label, kind] = campaignBadge(campaign);
    const prioritized = state.settings.priority.includes(campaign.game);
    return `<article class="campaign-row">
      ${artwork(campaign.image, "campaign-image")}
      <div class="campaign-name"><a href="/campaigns/${encodeURIComponent(campaign.id)}" data-route>${esc(campaign.name)}</a><small>${esc(campaign.game)}</small></div>
      <div class="campaign-progress"><small>${campaign.claimedDrops}/${campaign.totalDrops} drops · ${Math.round(campaign.progress * 100)}%</small><div class="progress"><span style="width:${campaign.progress * 100}%"></span></div></div>
      <div class="campaign-time">${campaign.status === "upcoming" ? "Starts" : "Ends"} ${esc(formatDate(campaign.status === "upcoming" ? campaign.startsAt : campaign.endsAt, true))}<small>${esc(formatDate(campaign.status === "upcoming" ? campaign.startsAt : campaign.endsAt))}</small></div>
      <div><span class="status-badge ${kind}">${esc(label)}</span>${prioritized ? '<div class="muted" style="margin-top:5px;font-size:11px">Prioritized</div>' : ""}${feasibility(campaign)}</div>
    </article>`;
  }).join("") : `<div class="empty-state"><div><strong>No matching campaigns</strong><p>Try another search or filter.</p></div></div>`);
}

function campaignDetailTemplate(campaign) {
  if (!campaign) return `<section class="panel empty-state"><div><h2>Campaign not found</h2><p>It may have disappeared during an inventory refresh.</p><a class="button secondary" href="/campaigns" data-route>Back to campaigns</a></div></section>`;
  const [label, kind] = campaignBadge(campaign);
  const isPriority = state.settings.priority.includes(campaign.game);
  const isExcluded = state.settings.exclude.includes(campaign.game);
  return `
    <div class="button-row" style="margin-bottom:14px"><a class="button quiet small" href="/campaigns" data-route>← All campaigns</a></div>
    <div class="campaign-detail">
      <section class="panel"><div class="panel-body">
        <div class="campaign-summary">${artwork(campaign.image, "campaign-image")}<div><span class="status-badge ${kind}">${esc(label)}</span><h2 style="margin-top:8px">${esc(campaign.name)}</h2><p class="muted">${esc(campaign.game)}</p><p>${campaign.claimedDrops}/${campaign.totalDrops} drops claimed · ${Math.round(campaign.progress * 100)}% complete</p></div></div>
        <div class="drop-list">${campaign.drops.map(drop => {
          const benefit = drop.benefits?.[0];
          const dropLabel = drop.claimed ? ["Claimed", "good"] : drop.claimable ? ["Ready to claim", "warn"] : [`${Math.round(drop.progress * 100)}%`, ""];
          return `<article class="drop-row">${benefit?.image ? `<span class="artwork drop-art"><img src="${esc(benefit.image)}" alt="">${icon("gift")}</span>` : '<div class="reward-fallback" style="width:42px;height:42px;font-size:16px" aria-hidden="true">◆</div>'}<div><strong>${esc(drop.rewards || drop.name)}</strong><small>${esc(drop.name)} · ${drop.currentMinutes}/${drop.requiredMinutes} minutes</small>${drop.prerequisites?.length ? `<small>Requires: ${drop.prerequisites.map(item => `${esc(item.name)} (${item.claimed ? "claimed" : "not claimed"})`).join(", ")}</small>` : ""}</div><span class="status-badge ${dropLabel[1]}">${dropLabel[0]}</span></article>`;
        }).join("") || '<div class="empty-state">No drops in this campaign.</div>'}</div>
      </div></section>
      <aside>
        <section class="panel side-note"><h3>Availability</h3><p>Starts ${esc(formatDate(campaign.startsAt))}</p><p>Ends ${esc(formatDate(campaign.endsAt))}</p><p>${esc(formatMinutes(campaign.remainingMinutes))} of eligible viewing. This excludes waiting for live channels and earlier games in your plan.</p></section>
        ${!campaign.linked && campaign.linkUrl ? `<section class="panel side-note" style="margin-top:14px"><h3>Account connection required</h3><p>Connect the game account associated with this campaign before its rewards can be earned.</p><a class="button primary small" href="${esc(campaign.linkUrl)}" target="_blank" rel="noreferrer" style="display:inline-block;margin-top:13px">Open connection page</a></section>` : ""}
        <section class="panel side-note" style="margin-top:14px"><h3>Mining preference</h3><p>The miner chooses games, so this preference applies to every eligible campaign for ${esc(campaign.game)}.</p><div class="button-row" style="margin-top:14px"><button class="button primary small" data-preference="priority" data-game="${esc(campaign.game)}" ${isPriority ? "disabled" : ""}>${isPriority ? "Prioritized" : "Mine this game first"}</button><button class="button secondary small" data-preference="exclude" data-game="${esc(campaign.game)}" ${isExcluded ? "disabled" : ""}>${isExcluded ? "Excluded" : "Exclude game"}</button></div></section>
      </aside>
    </div>`;
}

function saveBarTemplate() {
  return `<div class="save-bar ${settingsDirty ? "" : "hidden"}" id="save-bar"><p>You have unsaved changes.</p><div class="button-row"><button class="button quiet small" type="button" data-discard-settings>Discard</button><button class="button primary small" type="button" data-save-settings>Save changes</button></div></div>`;
}

function priorityRows() {
  return settingsDraft.priority.length ? settingsDraft.priority.map((game, index) => `<div class="queue-row">
    <span class="queue-number">${index + 1}</span>
    <span><strong>${esc(game)}</strong><small>${index === 0 ? "First choice" : "Mined after higher priorities"}</small></span>
    <span class="queue-controls">
      <button class="icon-button" type="button" data-list-action="up" data-list="priority" data-index="${index}" aria-label="Move ${esc(game)} up" ${index === 0 ? "disabled" : ""}>↑</button>
      <button class="icon-button" type="button" data-list-action="down" data-list="priority" data-index="${index}" aria-label="Move ${esc(game)} down" ${index === settingsDraft.priority.length - 1 ? "disabled" : ""}>↓</button>
      <button class="icon-button" type="button" data-list-action="remove" data-list="priority" data-index="${index}" aria-label="Remove ${esc(game)}">×</button>
    </span>
  </div>`).join("") : `<div class="empty-state"><div><strong>No priority games</strong><p>Add games below or let the miner choose automatically.</p></div></div>`;
}

function excludedTags() {
  return settingsDraft.exclude.length ? settingsDraft.exclude.map((game, index) => `<span class="tag">${esc(game)}<button type="button" data-list-action="remove" data-list="exclude" data-index="${index}" aria-label="Remove ${esc(game)}">×</button></span>`).join("") : `<span class="muted">No games excluded.</span>`;
}

function gamePicker(listName, placeholder) {
  const label = listName === "priority" ? "Add a priority game" : "Exclude a game";
  return `<div class="game-picker">
    <input id="${listName}-game" type="search" data-game-input="${listName}" placeholder="${placeholder}" role="combobox" aria-label="${label}" aria-autocomplete="list" aria-controls="${listName}-options" aria-expanded="false" autocomplete="off" spellcheck="false">
    <div class="game-options" id="${listName}-options" role="listbox" hidden></div>
  </div><button class="button secondary" type="button" data-add-list="${listName}" disabled>Add</button>`;
}

function miningTemplate() {
  return `
    <div class="mining-layout">
      <section class="panel queue-editor">
        <div class="panel-header"><div><h2>Game priority</h2><p class="muted">The first eligible game with a live channel is mined</p></div></div>
        <div id="priority-rows">${priorityRows()}</div>
        <div class="add-row">${gamePicker("priority", "Search discovered games")}</div>
      </section>
      <div>
        <section class="panel">
          <div class="panel-header"><div><h2>Fallback rule</h2><p class="muted">Used after priority games</p></div></div>
          <div class="panel-body"><label for="priority-mode" class="muted">Order other eligible games</label><select id="priority-mode" data-setting="priorityMode" style="margin-top:7px"><option value="PRIORITY_ONLY" ${settingsDraft.priorityMode === "PRIORITY_ONLY" ? "selected" : ""}>Do not mine other games</option><option value="ENDING_SOONEST" ${settingsDraft.priorityMode === "ENDING_SOONEST" ? "selected" : ""}>Campaign ending soonest</option><option value="LOW_AVBL_FIRST" ${settingsDraft.priorityMode === "LOW_AVBL_FIRST" ? "selected" : ""}>Lowest channel availability</option></select></div>
        </section>
        <section class="panel" style="margin-top:14px">
          <div class="panel-header"><div><h2>Excluded games</h2><p class="muted">Never select these games</p></div></div>
          <div class="excluded-tags" id="excluded-tags">${excludedTags()}</div>
          <div class="add-row">${gamePicker("exclude", "Search discovered games")}</div>
        </section>
      </div>
    </div>
    ${saveBarTemplate()}
    <div class="section-title"><div><h2>Channels</h2><p class="muted">Streams discovered for your mining plan</p></div><span class="muted" id="channel-count"></span></div>
    <section class="panel channel-list" id="channel-list"></section>`;
}

function updateChannels() {
  const container = $("#channel-list");
  if (!container) return;
  const channels = [...state.channels].sort((a, b) => Number(b.watching) - Number(a.watching) || Number(b.watchable) - Number(a.watchable) || (b.viewers || 0) - (a.viewers || 0));
  $("#channel-count").textContent = `${channels.filter(channel => channel.online).length} live · ${channels.filter(channel => channel.watchable).length} eligible`;
  setContent("#channel-list", channels.length ? channels.map(channel => `<article class="channel-row">
    <div><strong>${esc(channel.name)}</strong><small>${esc(channel.title || (channel.online ? "Live" : "Offline"))}</small></div>
    <div class="channel-game"><strong>${esc(channel.game || "No game")}</strong><small>${channel.dropsEnabled ? "Drops enabled" : "Drops unavailable"}</small></div>
    <div class="channel-viewers"><strong>${channel.viewers == null ? "—" : Number(channel.viewers).toLocaleString()}</strong><small>viewers</small></div>
    <button class="button ${channel.watching ? "primary" : "secondary"} small" type="button" data-channel="${channel.id}" ${!channel.watchable || channel.watching ? "disabled" : ""}>${channel.watching ? "Watching" : channel.watchable ? "Switch" : "Unavailable"}</button>
  </article>`).join("") : `<div class="empty-state"><div><strong>No eligible live channels</strong><p>The miner will keep checking automatically.</p></div></div>`);
}

function settingsTemplate() {
  return `
    <div class="settings-layout">
      <div>
        <section class="panel setting-section">
          <div class="panel-header"><div><h2>Appearance</h2><p class="muted">A palette for your setup.</p></div></div>
          <div class="theme-options" role="group" aria-label="Color theme">${Object.entries(themeNames).map(([value, label]) => `<button type="button" class="theme-option" data-theme-choice="${value}" aria-pressed="${themePreference === value}"><span class="theme-preview preview-${value}" aria-hidden="true"><i></i><i></i><i></i></span><span class="theme-label">${label}<span class="theme-check" aria-hidden="true">${icon("check")}</span></span><small>${esc(themeDescriptions[value])}</small></button>`).join("")}</div>
          <p class="theme-note">Applies immediately and is remembered in this browser. System follows your device’s light or dark appearance.</p>
        </section>
        <section class="panel setting-section">
          <div class="panel-header"><div><h2>Campaigns</h2><p class="muted">Control which kinds of drops can be mined</p></div></div>
          <div class="setting-row toggle-row"><div><strong>Badge and emote campaigns</strong><p>Include campaigns whose rewards are Twitch badges or emotes.</p></div><label class="switch"><input type="checkbox" data-setting="enableBadgesEmotes" ${settingsDraft.enableBadgesEmotes ? "checked" : ""} aria-label="Include badge and emote campaigns"><span></span></label></div>
          <div class="setting-row toggle-row"><div><strong>Verify drops on each channel</strong><p>Check campaign availability per channel before switching.</p></div><label class="switch"><input type="checkbox" data-setting="availableDropsCheck" ${settingsDraft.availableDropsCheck ? "checked" : ""} aria-label="Verify drops on each channel"><span></span></label></div>
        </section>
        <section class="panel setting-section">
          <div class="panel-header"><div><h2>Notifications</h2><p class="muted">Choose what appears in the activity feed</p></div></div>
          <div class="setting-row toggle-row"><div><strong>Claim notifications</strong><p>Record a notification whenever a drop is claimed.</p></div><label class="switch"><input type="checkbox" data-setting="trayNotifications" ${settingsDraft.trayNotifications ? "checked" : ""} aria-label="Show claim notifications"><span></span></label></div>
        </section>
        <section class="panel setting-section"><div class="panel-header"><div><h2>Webhook notifications</h2><p class="muted">Send claim notifications to your configured service</p></div></div><div class="setting-row"><div><label for="webhook-url"><strong>Webhook URL</strong></label><p>${state.system.webhookManagedByEnvironment ? "Managed by the launch environment." : "Save the URL before sending a test notification."}</p></div><input id="webhook-url" type="url" autocomplete="off" spellcheck="false" data-setting="webhookUrl" value="${esc(settingsDraft.webhookUrl)}" ${state.system.webhookManagedByEnvironment ? "disabled" : ""}></div><div class="panel-body"><button class="button secondary small" data-action="test-webhook" ${settingsDirty || (!settingsDraft.webhookUrl && !state.system.webhookManagedByEnvironment) ? "disabled" : ""}>Test notification</button></div></section>
        ${state.system.platform.startsWith("Windows") ? `<section class="panel setting-section">
          <div class="panel-header"><div><h2>Windows</h2><p class="muted">Desktop convenience and reliability</p></div></div>
          <div class="setting-row toggle-row"><div><strong>Start with Windows</strong><p>Launch minimized to the system tray after sign-in.</p></div><label class="switch"><input type="checkbox" data-setting="autostart" ${settingsDraft.autostart ? "checked" : ""}><span></span></label></div>
          <div class="setting-row toggle-row"><div><strong>Keep PC awake while mining</strong><p>Prevent system sleep only while a drop is active.</p></div><label class="switch"><input type="checkbox" data-setting="keepAwake" ${settingsDraft.keepAwake ? "checked" : ""}><span></span></label></div>
        </section>` : ""}
        <section class="panel setting-section">
          <div class="panel-header"><div><h2>Network</h2><p class="muted">Usually best left at the defaults</p></div></div>
          <div class="setting-row"><div><label for="connection-quality"><strong>Connection tolerance</strong></label><p>Higher values give slow or unreliable networks more time.</p></div><div><input id="connection-quality" type="range" min="1" max="6" value="${settingsDraft.connectionQuality}" data-setting="connectionQuality"><div class="progress-meta"><span>Fast</span><output id="quality-output">${settingsDraft.connectionQuality} / 6</output><span>Tolerant</span></div></div></div>
          <div class="setting-row"><div><label for="proxy"><strong>HTTP proxy</strong></label><p>Optional. Include a scheme, hostname, and explicit port.</p></div><div><input id="proxy" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="http://localhost:3128" value="${esc(settingsDraft.proxy)}" data-setting="proxy"><p class="form-error hidden" id="proxy-error">Enter a complete proxy URL including its port.</p></div></div>
        </section>
        ${saveBarTemplate()}
      </div>
      <aside>
        <section class="panel side-note"><h3>Your mining plan</h3><p>Choose your priority games, exclude others, and decide what to mine next.</p><a class="button secondary small" href="/mining" data-route style="display:inline-block;margin-top:13px">Open mining plan</a></section>
        <section class="panel danger-zone" style="margin-top:14px"><div class="panel-header"><div><h2>Account and system</h2><p class="muted">Actions that interrupt the miner</p></div></div><div class="panel-body button-row"><button class="button secondary small" data-action="logout" ${state.canLogout ? "" : "disabled"}>Disconnect Twitch</button><button class="button secondary small" data-action="restart">Restart miner</button><button class="button danger small" data-action="shutdown">Shut down</button></div></section>
      </aside>
    </div>`;
}

function diagnosticsTemplate() {
  const socketTopics = state.websockets.reduce((sum, socket) => sum + (socket.topics || 0), 0);
  const lines = [...(state.messages || [])].reverse();
  const notifications = state.notifications || [];
  return `
    <div class="diagnostic-grid">
      <article class="panel diagnostic-card"><span>Miner state</span><strong>${esc(state.activity || "Unknown")}</strong><small>${esc(state.status || "No status message")}</small></article>
      <article class="panel diagnostic-card"><span>Event sockets</span><strong>${state.websockets.length || 0}</strong><small>${socketTopics} subscribed topics</small></article>
      <article class="panel diagnostic-card"><span>Dashboard stream</span><strong>${connected ? "Connected" : "Reconnecting"}</strong><small>State revision ${state.revision}</small></article>
      <article class="panel diagnostic-card"><span>Version</span><strong>${esc(state.system.version)}</strong><small>Engine ${esc(state.system.upstreamVersion)}</small></article>
      <article class="panel diagnostic-card"><span>Watch failures</span><strong>${state.stats.lifetime.watch_failures || 0}</strong><small>${state.stats.lifetime.watch_heartbeats || 0} heartbeats</small></article>
      <article class="panel diagnostic-card"><span>Last progress</span><strong>${esc(formatDate(state.stats.lifetime.last_progress_at, true))}</strong><small>${esc(formatDate(state.stats.lifetime.last_progress_at))}</small></article>
    </div>
    <section class="panel">
      <div class="panel-header"><div><h2>Event log</h2><p class="muted">Newest events appear first</p></div><div class="button-row"><button class="button secondary small" type="button" data-copy-log>Copy log</button><a class="button secondary small" href="/api/diagnostics" download>Download</a></div></div>
      <div class="log" id="activity-log">${notifications.map(item => `<p class="notification"><strong>${esc(formatDate(item.time))} · ${esc(item.title)}</strong> ${esc(item.message)}</p>`).join("")}${lines.map(item => `<p><small>${esc(formatDate(item.time))}</small> ${esc(item.message || item)}</p>`).join("") || (!notifications.length ? "<p>Waiting for miner events…</p>" : "")}</div>
    </section>
    <section class="panel side-note" style="margin-top:14px"><h3>Network health</h3><p>${state.networkIssues?.length ? `Requests are failing for ${esc(state.networkIssues.join(", "))}.` : "No repeated Twitch network failures have been detected."}</p><p class="muted">${esc(state.system.platform)} · Python ${esc(state.system.python)} · ${state.system.authenticationEnabled ? "Dashboard authentication enabled" : "Dashboard authentication disabled"}</p><div class="button-row" style="margin-top:12px"><a class="button secondary small" href="/api/export?stats=1" download>Export settings & stats</a>${state.system.platform.startsWith("Windows") ? '<button class="button secondary small" data-action="open-data">Open data folder</button><button class="button secondary small" data-action="open-log">Open log</button>' : ""}</div><label class="button quiet small" style="display:inline-block;margin-top:10px">Import settings<input type="file" accept="application/json" data-import-settings hidden></label></section>`;
}

let historyOffset = 0;
let historyGame = "";
let historyQuery = "";
let historyRequest = 0;
function historyTemplate() {
  return `<form id="history-filters" class="history-filters"><label>Search rewards<input type="search" id="history-query" value="${esc(historyQuery)}" placeholder="Reward or campaign name"></label><label>Game<select id="history-game"><option value="">All games</option><option value="unknown">Unknown game</option></select></label><button class="button secondary" type="submit">Search</button></form><div id="history-summary"></div><div id="history-results" aria-live="polite"></div>`;
}
async function loadHistory() {
  const requestId = ++historyRequest;
  const results = $("#history-results");
  if (!results) return;
  results.innerHTML = '<p role="status">Loading saved rewards…</p>';
  try {
    const data = await request(`/api/history?${new URLSearchParams({game: historyGame, q: historyQuery, offset: String(historyOffset)})}`);
    if (requestId !== historyRequest || !results.isConnected) return;
    const summary = data.summary || {};
    const select = $("#history-game");
    select.innerHTML = `<option value="">All games</option><option value="unknown">Unknown game</option>${(summary.games || []).filter(game => game.id && game.id !== "unknown").map(game => `<option value="${esc(game.id)}">${esc(game.name)} (${game.rewardCount})</option>`).join("")}`;
    select.value = historyGame;
    $("#history-summary").innerHTML = `<p class="collection-summary">${summary.rewardCount || 0} saved reward${summary.rewardCount === 1 ? "" : "s"} · ${summary.gameCount || 0} game${summary.gameCount === 1 ? "" : "s"} · ${summary.localClaimCount || 0} claims recorded by this miner${summary.dailyClaims ? ` · ${summary.dailyClaims.reduce((sum, day) => sum + (Number(day.count) || 0), 0)} in the last 30 days (UTC)` : ""}</p><p class="history-coverage">${esc(summary.coverage || "Includes rewards observed by this miner and returned by Twitch. Twitch may not provide every historical reward or its claim date.")}${summary.lastSyncedAt ? ` Last synced ${esc(formatDate(summary.lastSyncedAt))}.` : " No history sync yet."}</p>`;
    results.innerHTML = (data.items || []).length ? `<div class="panel history-list">${data.items.map(item => `<article class="history-row">${artwork(item.imageUrl, "history-art")}<div><strong>${esc(item.name)}</strong><small><button type="button" class="history-game-link" data-history-game="${esc(item.gameId || "unknown")}">${esc(item.gameName || "Unknown game")}</button>${item.campaignName ? ` · ${esc(item.campaignName)}` : ""}</small></div><div class="history-date"><span>${item.lastAwardedAt ? esc(formatDate(item.lastAwardedAt)) : ["local", "both"].includes(item.source) && item.observedAt ? `Recorded ${esc(formatDate(item.observedAt))}` : "Claim date unavailable"}</span><small>${item.awardCount > 1 ? `${item.awardCount} awards recorded · ` : ""}${item.source === "local" ? "Recorded by this miner" : item.source === "both" ? "Recorded locally and in Twitch inventory" : "Observed in Twitch inventory"}</small></div></article>`).join("")}</div><div class="history-pagination"><button class="button secondary small" data-history-page="previous" ${historyOffset ? "" : "disabled"}>Previous</button><span>${historyOffset + 1}–${historyOffset + data.items.length} of ${data.total}</span><button class="button secondary small" data-history-page="next" ${historyOffset + data.items.length < data.total ? "" : "disabled"}>Next</button></div>` : '<div class="empty-state"><div><strong>No saved rewards found</strong><p>Try a different search or game. Rewards are saved when Twitch inventory is refreshed and when the miner claims them.</p></div></div>';
  } catch (error) {
    if (requestId !== historyRequest || !results.isConnected) return;
    results.innerHTML = `<div class="empty-state"><div><strong>Could not load reward history</strong><p>${esc(error.message)}</p><button class="button secondary" data-history-retry>Try again</button></div></div>`;
  }
}

function renderRoute(force = false) {
  if (!state || $("#app-shell").classList.contains("hidden")) return;
  const route = routeFromPath();
  const changed = !activeRoute || route.name !== activeRoute.name || route.id !== activeRoute.id;
  activeRoute = route;
  updateChrome();
  if (changed || force) {
    if (route.name === "history") { $("#view").innerHTML = historyTemplate(); loadHistory(); }
    if (route.name === "dashboard") $("#view").innerHTML = dashboardTemplate();
    if (route.name === "campaigns") $("#view").innerHTML = campaignListTemplate();
    if (route.name === "campaign") $("#view").innerHTML = campaignDetailTemplate(state.campaigns.find(item => item.id === route.id));
    if (route.name === "mining") $("#view").innerHTML = miningTemplate();
    if (route.name === "settings") $("#view").innerHTML = settingsTemplate();
    if (route.name === "diagnostics") $("#view").innerHTML = diagnosticsTemplate();
  }
  if (route.name === "dashboard") updateDashboard();
  if (route.name === "campaigns") updateCampaignList();
  if (route.name === "campaign" && !changed && !settingsDirty) setContent("#view", campaignDetailTemplate(state.campaigns.find(item => item.id === route.id)));
  if (route.name === "mining" && !changed && !settingsDirty && !document.activeElement.closest("#view")) $("#view").innerHTML = miningTemplate();
  if (route.name === "mining") updateChannels();
  if (route.name === "settings" && !changed && !settingsDirty && !document.activeElement.closest("#view")) $("#view").innerHTML = settingsTemplate();
  if (route.name === "diagnostics" && !changed && !document.activeElement.closest("#view")) $("#view").innerHTML = diagnosticsTemplate();
}

function navigate(path, {replace = false, focus = true} = {}) {
  if (settingsDirty && !confirm("Discard your unsaved changes?")) return;
  settingsDirty = false;
  if (replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  currentPath = path;
  activeRoute = null;
  renderRoute();
  scrollTo(0, 0);
  if (focus) $("#view").focus({preventScroll: true});
}

function markSettingsDirty() {
  settingsDirty = true;
  const webhookTest = $('[data-action="test-webhook"]');
  if (webhookTest) webhookTest.disabled = true;
  $("#save-bar")?.classList.remove("hidden");
}

function matchingGames(listName, query) {
  const selected = new Set(settingsDraft[listName]);
  const needle = query.trim().toLocaleLowerCase();
  return state.games.filter(game => !selected.has(game) && (!needle || game.toLocaleLowerCase().includes(needle))).slice(0, 8);
}

function closeGamePicker(input) {
  $(`#${input.dataset.gameInput}-options`).hidden = true;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
}

function updateGamePicker(input, open = true) {
  const listName = input.dataset.gameInput;
  const matches = matchingGames(listName, input.value);
  const active = Math.min(Number(input.dataset.active || 0), Math.max(0, matches.length - 1));
  input.dataset.active = active;
  const options = $(`#${listName}-options`);
  options.innerHTML = matches.map((game, index) => `<button id="${listName}-option-${index}" type="button" role="option" data-game-option="${esc(game)}" data-list="${listName}" aria-selected="${index === active}">${esc(game)}</button>`).join("") || `<p>No matching games</p>`;
  options.hidden = !open;
  input.setAttribute("aria-expanded", String(open));
  if (open && matches.length) input.setAttribute("aria-activedescendant", `${listName}-option-${active}`);
  else input.removeAttribute("aria-activedescendant");
  $(`[data-add-list="${listName}"]`).disabled = !state.games.includes(input.value) || settingsDraft[listName].includes(input.value);
}

function updateMiningEditor() {
  $("#priority-rows").innerHTML = priorityRows();
  $("#excluded-tags").innerHTML = excludedTags();
  $$('[data-game-input]').forEach(input => updateGamePicker(input, false));
}

function addGameToList(listName, selectedGame) {
  const input = $(`#${listName}-game`);
  const game = selectedGame || state.games.find(item => item === input.value.trim());
  if (!game) {
    toast("Choose a game from the results", true);
    return;
  }
  const other = listName === "priority" ? "exclude" : "priority";
  settingsDraft[other] = settingsDraft[other].filter(item => item !== game);
  if (!settingsDraft[listName].includes(game)) settingsDraft[listName].push(game);
  markSettingsDirty();
  input.value = "";
  updateMiningEditor();
  input.focus();
  closeGamePicker(input);
}

function changeListItem(button) {
  const list = settingsDraft[button.dataset.list];
  const index = Number(button.dataset.index);
  if (button.dataset.listAction === "remove") list.splice(index, 1);
  if (button.dataset.listAction === "up" && index > 0) [list[index - 1], list[index]] = [list[index], list[index - 1]];
  if (button.dataset.listAction === "down" && index < list.length - 1) [list[index + 1], list[index]] = [list[index], list[index + 1]];
  markSettingsDirty();
  updateMiningEditor();
}

function validProxy(value) {
  if (!value.trim()) return true;
  try {
    const url = new URL(value);
    return Boolean(url.hostname && url.port);
  } catch (_error) {
    return false;
  }
}

document.addEventListener("submit", event => {
  if (event.target.id !== "history-filters") return;
  event.preventDefault();
  historyQuery = $("#history-query").value.trim();
  historyGame = $("#history-game").value;
  historyOffset = 0;
  loadHistory();
});

document.addEventListener("click", async event => {
  if (event.target.closest("[data-history-retry]")) { loadHistory(); return; }
  const gameButton = event.target.closest("[data-history-game]");
  if (gameButton) { historyGame = gameButton.dataset.historyGame; historyOffset = 0; loadHistory(); return; }
  const pageButton = event.target.closest("[data-history-page]");
  if (pageButton) { historyOffset = Math.max(0, historyOffset + (pageButton.dataset.historyPage === "next" ? 50 : -50)); loadHistory(); return; }
  const themeButton = event.target.closest("[data-theme-choice]");
  if (themeButton) {
    chooseTheme(themeButton.dataset.themeChoice);
    return;
  }
  const routeLink = event.target.closest("a[data-route]");
  if (routeLink && routeLink.origin === location.origin && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
    event.preventDefault();
    navigate(routeLink.pathname);
    return;
  }
  const action = event.target.closest("[data-action]");
  if (action) {
    const name = action.dataset.action;
    if (["logout", "shutdown", "restart"].includes(name) && !confirm(`${action.textContent.trim()}?`)) return;
    action.disabled = true;
    try {
      await request(`/api/actions/${name}`, {method: "POST"});
      toast(`${action.textContent.trim()} requested`);
    } catch (error) {
      toast(error.message || "Request failed", true);
    } finally {
      action.disabled = false;
    }
    return;
  }
  const filter = event.target.closest("[data-campaign-filter]");
  if (filter) {
    campaignFilter = filter.dataset.campaignFilter;
    $$('[data-campaign-filter]').forEach(button => button.setAttribute("aria-pressed", String(button === filter)));
    updateCampaignList();
    return;
  }
  const preference = event.target.closest("[data-preference]");
  if (preference) {
    await updateGamePreference(preference.dataset.game, preference.dataset.preference);
    return;
  }
  const listAction = event.target.closest("[data-list-action]");
  if (listAction) {
    changeListItem(listAction);
    return;
  }
  const gameOption = event.target.closest("[data-game-option]");
  if (gameOption) {
    addGameToList(gameOption.dataset.list, gameOption.dataset.gameOption);
    return;
  }
  const addList = event.target.closest("[data-add-list]");
  if (addList) {
    addGameToList(addList.dataset.addList);
    return;
  }
  $$('[data-game-input]').forEach(input => {
    if (!event.target.closest(".game-picker")) closeGamePicker(input);
  });
  const channel = event.target.closest("[data-channel]");
  if (channel) {
    channel.disabled = true;
    try {
      await request(`/api/channels/${channel.dataset.channel}`, {method: "POST"});
      toast("Channel switch requested");
    } catch (error) {
      toast(error.message || "Unable to switch channel", true);
      channel.disabled = false;
    }
    return;
  }
  if (event.target.closest("[data-discard-settings]")) {
    syncSettingsDraft(true);
    renderRoute(true);
    toast("Changes discarded");
    return;
  }
  if (event.target.closest("[data-save-settings]")) {
    const proxyError = $("#proxy-error");
    if (!validProxy(settingsDraft.proxy)) {
      proxyError?.classList.remove("hidden");
      $("#proxy")?.focus();
      return;
    }
    await saveSettings();
    return;
  }
  if (event.target.closest("[data-copy-log]")) {
    try {
      await navigator.clipboard.writeText($("#activity-log").innerText);
      toast("Activity log copied");
    } catch (_error) {
      toast("Unable to copy the activity log", true);
    }
    return;
  }
  if (event.target.closest("#copy-code")) {
    try {
      await navigator.clipboard.writeText($("#activation-code").textContent);
      toast("Authorization code copied");
    } catch (_error) {
      toast("Unable to copy the code", true);
    }
  }
});

document.addEventListener("input", event => {
  if (event.target.matches("[data-game-input]")) {
    event.target.dataset.active = 0;
    updateGamePicker(event.target);
    return;
  }
  if (event.target.id === "campaign-search") {
    campaignQuery = event.target.value;
    updateCampaignList();
    return;
  }
  const setting = event.target.closest("[data-setting]");
  if (setting) {
    const key = setting.dataset.setting;
    settingsDraft[key] = setting.type === "checkbox" ? setting.checked : setting.type === "range" ? Number(setting.value) : setting.value;
    if (setting.id === "connection-quality") $("#quality-output").textContent = `${setting.value} / 6`;
    if (setting.id === "proxy") $("#proxy-error").classList.toggle("hidden", validProxy(setting.value));
    markSettingsDirty();
  }
});

document.addEventListener("focusin", event => {
  if (event.target.matches("[data-game-input]")) updateGamePicker(event.target);
});

document.addEventListener("change", event => {
  if (event.target.id === "quick-theme") {
    chooseTheme(event.target.value);
    return;
  }
  if (event.target.matches("[data-import-settings]")) {
    const file = event.target.files?.[0];
    if (!file) return;
    file.text().then(text => request("/api/import", {method: "POST", body: text}))
      .then(() => { toast("Settings imported"); location.reload(); })
      .catch(error => toast(error.message || "Import failed", true));
    return;
  }
  const setting = event.target.closest("[data-setting]");
  if (!setting) return;
  settingsDraft[setting.dataset.setting] = setting.type === "checkbox" ? setting.checked : setting.type === "range" ? Number(setting.value) : setting.value;
  markSettingsDirty();
});

document.addEventListener("keydown", event => {
  const input = event.target.closest("[data-game-input]");
  if (!input) return;
  if (event.key === "Escape" || event.key === "Tab") {
    closeGamePicker(input);
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
  event.preventDefault();
  const matches = matchingGames(input.dataset.gameInput, input.value);
  if (!matches.length) return;
  if (event.key === "ArrowDown") input.dataset.active = (Number(input.dataset.active || 0) + 1) % matches.length;
  if (event.key === "ArrowUp") input.dataset.active = (Number(input.dataset.active || 0) - 1 + matches.length) % matches.length;
  if (event.key === "Enter") {
    addGameToList(input.dataset.gameInput, state.games.includes(input.value) ? input.value : matches[Number(input.dataset.active || 0)]);
    return;
  }
  updateGamePicker(input);
});

addEventListener("popstate", () => {
  if (settingsDirty && !confirm("Discard your unsaved changes?")) {
    history.pushState({}, "", currentPath);
    return;
  }
  currentPath = location.pathname;
  activeRoute = null;
  settingsDirty = false;
  renderRoute();
  scrollTo(0, 0);
});

addEventListener("beforeunload", event => {
  if (!settingsDirty) return;
  event.preventDefault();
  event.returnValue = "";
});

function chooseTheme(value) {
  if (!Object.hasOwn(themeNames, value)) return;
  themePreference = value;
  applyTheme();
  $("#quick-theme").value = value;
  $$('[data-theme-choice]').forEach(button => button.setAttribute("aria-pressed", String(button.dataset.themeChoice === value)));
  try { localStorage.setItem("tdm-theme", value); }
  catch (_) { toast("Theme applied. This browser could not save your preference.", true); }
}
$("#quick-theme").innerHTML = Object.entries(themeNames).map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
$("#quick-theme").value = themePreference;
// Missing third-party artwork should leave an intentional placeholder, never a broken image.
document.addEventListener("error", event => {
  if (event.target.matches?.(".artwork img")) event.target.remove();
}, true);

const events = new EventSource("/api/events");
events.onmessage = event => {
  const nextState = JSON.parse(event.data);
  const accountChanged = String(state?.login?.userId || "") !== String(nextState.login?.userId || "")
    || Boolean(state?.canLogout) !== Boolean(nextState.canLogout);
  if (accountChanged) {
    historyRequest++; // Ignore any response belonging to the previous account.
    historyOffset = 0;
    historyGame = "";
    historyQuery = "";
    if (activeRoute?.name === "history") {
      $("#view").replaceChildren();
      activeRoute = null;
    }
  }
  state = nextState;
  connected = true;
  syncSettingsDraft();
  showApplication();
};
events.onerror = () => {
  connected = false;
  if (state && !$("#app-shell").classList.contains("hidden")) {
    updateChrome();
    if (activeRoute?.name === "dashboard") updateDashboard();
  } else if (!state) {
    $("#loading").textContent = "Unable to reach the miner. Retrying automatically…";
  }
};
