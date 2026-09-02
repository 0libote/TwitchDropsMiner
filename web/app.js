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

const routeMeta = {
  dashboard: ["Miner", "Dashboard"],
  campaigns: ["Inventory", "Campaigns"],
  campaign: ["Campaign", "Campaign details"],
  mining: ["Control", "Mining"],
  settings: ["Preferences", "Settings"],
  diagnostics: ["System", "Diagnostics"],
};

function routeFromPath(path = location.pathname) {
  const detail = path.match(/^\/campaigns\/([^/]+)$/);
  if (detail) return {name: "campaign", id: decodeURIComponent(detail[1])};
  return {name: ({"/":"dashboard", "/campaigns":"campaigns", "/mining":"mining", "/settings":"settings", "/diagnostics":"diagnostics"})[path] || "dashboard"};
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

function toast(message, error = false) {
  const node = $("#toast");
  clearTimeout(toastTimer);
  node.textContent = message;
  node.classList.toggle("error", error);
  node.classList.add("show");
  toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
}

async function request(url, options = {}) {
  const response = await fetch(url, {headers: {"Content-Type": "application/json"}, ...options});
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
    proxy: values.proxy,
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
  $("#connection-label").textContent = connected ? (state.activity === "idle" ? "Miner paused" : "Miner connected") : "Reconnecting";
  $("#connection-detail").textContent = state.status || "Waiting for updates";

  const issues = state.networkIssues || [];
  const alert = $("#network-alert");
  alert.classList.toggle("hidden", !issues.length);
  alert.innerHTML = issues.length ? `<div><strong>Twitch service blocked or unreachable</strong><p>Requests to ${esc(issues.join(", "))} are failing. Drop progress may stop.</p></div><a href="https://github.com/0libote/TwitchDropsMiner#dns-blockers-and-firewalls" target="_blank" rel="noreferrer">Troubleshoot</a>` : "";

  const controls = [];
  if (route.name === "dashboard") {
    const idle = state.activity === "idle";
    controls.push(`<button class="button secondary" data-action="${idle ? "reload" : "pause"}" ${state.canLogout ? "" : "disabled"}>${idle ? "Resume" : "Pause"}</button>`);
    controls.push(`<button class="button primary" data-action="reload" ${state.canLogout ? "" : "disabled"}>Refresh</button>`);
  } else if (route.name === "campaigns") {
    controls.push(`<button class="button secondary" data-action="reload" ${state.canLogout ? "" : "disabled"}>Refresh inventory</button>`);
  }
  $("#topbar-actions").innerHTML = controls.join("");
}

function dashboardTemplate() {
  return `
    <div class="dashboard-grid">
      <section class="panel now-card" aria-labelledby="now-heading"><div class="now-body" id="now-body"></div></section>
      <section class="panel watching-card" aria-labelledby="watching-heading">
        <div class="panel-header"><div><h2 id="watching-heading">Current session</h2><p class="muted">What the miner is using now</p></div><a class="button quiet small" href="/mining" data-route>Manage</a></div>
        <div class="panel-body" id="session-facts"></div>
      </section>
    </div>
    <div class="section-title"><div><h2>Mining plan</h2><p class="muted">Priority games are tried in this order</p></div><a class="button quiet small" href="/mining" data-route>Edit plan</a></div>
    <section class="panel queue-preview" id="queue-preview"></section>
    <div class="section-title"><div><h2>Recent activity</h2><p class="muted">The latest useful miner events</p></div><a class="button quiet small" href="/diagnostics" data-route>View diagnostics</a></div>
    <section class="panel activity-preview" id="activity-preview"></section>`;
}

function updateDashboard() {
  const drop = state.activeDrop;
  const campaign = activeCampaign();
  const channel = activeChannel();
  const kind = statusKind();
  const rewardImage = drop?.benefits?.[0]?.image;
  const heading = drop?.rewards || (state.activity === "idle" ? "Mining is paused" : "Waiting for an eligible drop");
  const explanation = drop ? `${campaign?.game || "Active campaign"} · ${drop.name}` : "The miner will continue when an eligible campaign and live channel are available.";
  $("#now-body").innerHTML = `
    <div>
      <div class="state-label"><span class="status-dot ${kind}"></span><span>${esc(state.status || "Running")}</span></div>
      <h2 id="now-heading">${esc(heading)}</h2>
      <p class="now-meta">${esc(explanation)}</p>
      <div class="progress" role="progressbar" aria-label="Current drop progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round((drop?.progress || 0) * 100)}"><span style="width:${(drop?.progress || 0) * 100}%"></span></div>
      <div class="progress-meta"><span>${Math.round((drop?.progress || 0) * 100)}% complete</span><span>${drop ? esc(formatMinutes(drop.remainingMinutes)) : "—"}</span></div>
    </div>
    ${rewardImage ? `<img class="reward-image" src="${esc(rewardImage)}" alt="${esc(drop.rewards)}">` : `<div class="reward-fallback" aria-hidden="true">◆</div>`}`;

  $("#session-facts").innerHTML = `
    <div class="fact"><span>Game</span><strong>${esc(campaign?.game || "No game selected")}</strong></div>
    <div class="fact"><span>Channel</span><strong>${esc(channel?.name || "Looking for a channel")}</strong></div>
    <div class="fact"><span>Selection rule</span><strong>${esc(({PRIORITY_ONLY:"Priority list only",ENDING_SOONEST:"Ending soonest",LOW_AVBL_FIRST:"Lowest availability"})[state.settings.priorityMode] || "Automatic")}</strong></div>`;

  const priority = state.settings.priority;
  $("#queue-preview").innerHTML = priority.length ? priority.slice(0, 5).map((game, index) => `<div class="queue-row"><span class="queue-number">${index + 1}</span><span><strong>${esc(game)}</strong><small>${index === 0 ? "First choice" : "After higher priorities"}</small></span>${campaign?.game === game ? '<span class="status-badge good">Mining</span>' : ""}</div>`).join("") : `<div class="empty-state"><div><strong>No priority games</strong><p>The miner is using its automatic ordering rule.</p></div></div>`;

  const events = [...(state.notifications || []).map(item => ({title: item.title, text: item.message})), ...(state.messages || []).slice(-4).reverse().map(text => ({title: "Miner", text}))].slice(0, 5);
  $("#activity-preview").innerHTML = events.length ? events.map(item => `<div class="activity-row"><span class="status-dot live"></span><span><strong>${esc(item.title)}</strong><small>${esc(item.text)}</small></span></div>`).join("") : `<div class="empty-state"><span>No activity yet</span></div>`;
}

function campaignBadge(campaign) {
  if (campaign.finished) return ["Completed", "good"];
  if (!campaign.linked) return ["Account link needed", "danger"];
  if (!campaign.eligible) return ["Unavailable", "danger"];
  if (campaign.status === "active") return ["Active", "good"];
  if (campaign.status === "upcoming") return ["Upcoming", "warn"];
  return ["Expired", ""];
}

function campaignListTemplate() {
  return `
    <div class="campaign-toolbar">
      <label class="search"><span class="hidden">Search campaigns</span><input id="campaign-search" type="search" placeholder="Search campaigns or games" value="${esc(campaignQuery)}"></label>
      <div class="segmented" aria-label="Campaign filter">${[["available","Available"],["active","Active"],["upcoming","Upcoming"],["finished","Completed"],["all","All"]].map(([value, label]) => `<button type="button" data-campaign-filter="${value}" aria-pressed="${campaignFilter === value}">${label}</button>`).join("")}</div>
    </div>
    <section class="panel campaign-list" id="campaign-list" aria-live="polite"></section>`;
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
  $("#campaign-list").innerHTML = campaigns.length ? campaigns.map(campaign => {
    const [label, kind] = campaignBadge(campaign);
    const prioritized = state.settings.priority.includes(campaign.game);
    return `<article class="campaign-row">
      <img class="campaign-image" src="${esc(campaign.image)}" alt="" loading="lazy">
      <div class="campaign-name"><a href="/campaigns/${encodeURIComponent(campaign.id)}" data-route>${esc(campaign.name)}</a><small>${esc(campaign.game)}</small></div>
      <div class="campaign-progress"><small>${campaign.claimedDrops}/${campaign.totalDrops} drops · ${Math.round(campaign.progress * 100)}%</small><div class="progress"><span style="width:${campaign.progress * 100}%"></span></div></div>
      <div class="campaign-time">${campaign.status === "upcoming" ? "Starts" : "Ends"} ${esc(formatDate(campaign.status === "upcoming" ? campaign.startsAt : campaign.endsAt, true))}<small>${esc(formatDate(campaign.status === "upcoming" ? campaign.startsAt : campaign.endsAt))}</small></div>
      <div><span class="status-badge ${kind}">${esc(label)}</span>${prioritized ? '<div class="muted" style="margin-top:5px;font-size:11px">Prioritized</div>' : ""}</div>
    </article>`;
  }).join("") : `<div class="empty-state"><div><strong>No matching campaigns</strong><p>Try another search or filter.</p></div></div>`;
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
        <div class="campaign-summary"><img class="campaign-image" src="${esc(campaign.image)}" alt=""><div><span class="status-badge ${kind}">${esc(label)}</span><h2 style="margin-top:8px">${esc(campaign.name)}</h2><p class="muted">${esc(campaign.game)}</p><p>${campaign.claimedDrops}/${campaign.totalDrops} drops claimed · ${Math.round(campaign.progress * 100)}% complete</p></div></div>
        <div class="drop-list">${campaign.drops.map(drop => {
          const benefit = drop.benefits?.[0];
          const dropLabel = drop.claimed ? ["Claimed", "good"] : drop.claimable ? ["Ready to claim", "warn"] : [`${Math.round(drop.progress * 100)}%`, ""];
          return `<article class="drop-row">${benefit?.image ? `<img src="${esc(benefit.image)}" alt="">` : '<div class="reward-fallback" style="width:42px;height:42px;font-size:16px" aria-hidden="true">◆</div>'}<div><strong>${esc(drop.rewards || drop.name)}</strong><small>${esc(drop.name)} · ${drop.currentMinutes}/${drop.requiredMinutes} minutes</small></div><span class="status-badge ${dropLabel[1]}">${dropLabel[0]}</span></article>`;
        }).join("") || '<div class="empty-state">No drops in this campaign.</div>'}</div>
      </div></section>
      <aside>
        <section class="panel side-note"><h3>Availability</h3><p>Starts ${esc(formatDate(campaign.startsAt))}</p><p>Ends ${esc(formatDate(campaign.endsAt))}</p></section>
        <section class="panel side-note" style="margin-top:14px"><h3>Mining preference</h3><p>The miner chooses games, so this preference applies to every eligible campaign for ${esc(campaign.game)}.</p><div class="button-row" style="margin-top:14px"><button class="button primary small" data-preference="priority" data-game="${esc(campaign.game)}" ${isPriority ? "disabled" : ""}>${isPriority ? "Prioritized" : "Mine this game first"}</button><button class="button secondary small" data-preference="exclude" data-game="${esc(campaign.game)}" ${isExcluded ? "disabled" : ""}>${isExcluded ? "Excluded" : "Exclude game"}</button></div></section>
      </aside>
    </div>`;
}

function placeholderTemplate(title, text) {
  return `<section class="panel empty-state"><div><h2>${esc(title)}</h2><p>${esc(text)}</p></div></section>`;
}

function renderRoute(force = false) {
  if (!state || $("#app-shell").classList.contains("hidden")) return;
  const route = routeFromPath();
  const changed = !activeRoute || route.name !== activeRoute.name || route.id !== activeRoute.id;
  activeRoute = route;
  updateChrome();
  if (changed || force) {
    if (route.name === "dashboard") $("#view").innerHTML = dashboardTemplate();
    if (route.name === "campaigns") $("#view").innerHTML = campaignListTemplate();
    if (route.name === "campaign") $("#view").innerHTML = campaignDetailTemplate(state.campaigns.find(item => item.id === route.id));
    if (route.name === "mining") $("#view").innerHTML = placeholderTemplate("Mining controls", "Priority planning and channels are being moved here.");
    if (route.name === "settings") $("#view").innerHTML = placeholderTemplate("Settings", "Infrequent preferences and account controls live here.");
    if (route.name === "diagnostics") $("#view").innerHTML = placeholderTemplate("Diagnostics", "Connection information and the event log live here.");
  }
  if (route.name === "dashboard") updateDashboard();
  if (route.name === "campaigns") updateCampaignList();
}

function navigate(path, {replace = false, focus = true} = {}) {
  if (settingsDirty && !confirm("Discard your unsaved changes?")) return;
  settingsDirty = false;
  if (replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  activeRoute = null;
  renderRoute();
  scrollTo(0, 0);
  if (focus) $("#view").focus({preventScroll: true});
}

document.addEventListener("click", async event => {
  const routeLink = event.target.closest("a[data-route]");
  if (routeLink && routeLink.origin === location.origin) {
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
  if (preference) await updateGamePreference(preference.dataset.game, preference.dataset.preference);
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
  if (event.target.id === "campaign-search") {
    campaignQuery = event.target.value;
    updateCampaignList();
  }
});

addEventListener("popstate", () => {
  activeRoute = null;
  settingsDirty = false;
  renderRoute();
  scrollTo(0, 0);
});

const events = new EventSource("/api/events");
events.onmessage = event => {
  state = JSON.parse(event.data);
  connected = true;
  syncSettingsDraft();
  showApplication();
};
events.onerror = () => {
  connected = false;
  if (state && !$("#app-shell").classList.contains("hidden")) updateChrome();
};
