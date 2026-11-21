(() => {
  const THEMES = [
    "mocha",
    "latte",
    "macchiato",
    "frappe",
    "nord",
    "tokyonight",
    "dracula",
    "gruvbox",
    "rosepine",
  ];

  const state = {
    providers: [],
    activeProvider: "moviebox",
    items: [],
    selectedIndex: 0,
    currentDetails: null,
    selectedSeason: 0,
    selectedEpisode: 0,
    hlsInstance: null,
    dashInstance: null,
  };

  const $ = (id) => document.getElementById(id);

  function setStatus(msg) {
    $("status-msg").textContent = msg;
  }

  function setMobileView(view) {
    const ws = $("tui-workspace");
    if (!ws) return;
    ws.setAttribute("data-mobile-view", view);
    $("tab-mobile-catalog")?.classList.toggle("active", view === "catalog");
    $("tab-mobile-details")?.classList.toggle("active", view === "details");
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let idx = 0;
    let val = bytes;
    while (val >= 1024 && idx < units.length - 1) {
      val /= 1024;
      idx++;
    }
    return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
  }

  function applyTheme(theme) {
    const valid = THEMES.includes(theme) ? theme : "mocha";
    document.documentElement.setAttribute("data-theme", valid);
    $("theme-select").value = valid;
    localStorage.setItem("mb_theme", valid);
  }

  async function apiFetch(url, opts = {}) {
    const resp = await fetch(url, opts);
    if (resp.status === 401) {
      showGate();
      throw new Error("Session locked");
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    return data;
  }

  function showGate() {
    $("app-screen").classList.add("hidden");
    $("gate-screen").classList.remove("hidden");
    $("gate-input").value = "";
    $("gate-input").focus();
  }

  function showApp() {
    $("gate-screen").classList.add("hidden");
    $("app-screen").classList.remove("hidden");
  }

  async function initApp() {
    showApp();
    await loadProviders();
    await loadHomepage();
    refreshUpdaterStatus();
  }

  async function loadProviders() {
    try {
      state.providers = await apiFetch("/api/providers");
      renderProviders();
    } catch (e) {
      setStatus(`Failed to load providers: ${e.message}`);
    }
  }

  function renderProviders() {
    const container = $("provider-tabs");
    container.innerHTML = "";
    state.providers.forEach((p) => {
      const btn = document.createElement("button");
      btn.className = `provider-tab ${p.id === state.activeProvider ? "active" : ""}`;
      btn.textContent = p.label;
      btn.onclick = () => {
        state.activeProvider = p.id;
        renderProviders();
        const q = $("search-input").value.trim();
        if (q) {
          performSearch(q);
        } else if (p.id === "moviebox") {
          loadHomepage();
        } else {
          setMobileView("catalog");
          setStatus(`Switched to ${p.label}. Type a query to search.`);
        }
      };
      container.appendChild(btn);
    });
  }

  async function loadHomepage() {
    setMobileView("catalog");
    setStatus("Loading trending catalog...");
    $("catalog-title").textContent = "─ Trending / Home ─";
    try {
      const data = await apiFetch("/api/homepage?page=1");
      state.items = data.items || [];
      state.selectedIndex = 0;
      renderCatalog();
      setStatus(`Loaded ${state.items.length} trending items.`);
    } catch (e) {
      setStatus(`Homepage error: ${e.message}`);
    }
  }

  async function performSearch(query) {
    const q = query.trim();
    if (!q) return loadHomepage();
    $("suggest-box").classList.add("hidden");
    $("search-input").blur();
    setMobileView("catalog");
    setStatus(`Searching "${q}" on ${state.activeProvider}...`);
    $("catalog-title").textContent = `─ Search: ${q} ─`;
    try {
      const data = await apiFetch(
        `/api/search?q=${encodeURIComponent(q)}&provider=${encodeURIComponent(state.activeProvider)}&page=1`
      );
      state.items = data.items || [];
      state.selectedIndex = 0;
      renderCatalog();
      setStatus(`Found ${state.items.length} results for "${q}".`);
    } catch (e) {
      setStatus(`Search error: ${e.message}`);
    }
  }

  function renderCatalog() {
    const list = $("catalog-list");
    $("catalog-count").textContent = `${state.items.length} items`;
    if (!state.items.length) {
      list.innerHTML = `<div class="empty-state">No items found. Try another query or provider.</div>`;
      return;
    }

    list.innerHTML = state.items
      .map((item, idx) => {
        const selected = idx === state.selectedIndex;
        const poster = item.poster_url
          ? `<img class="catalog-thumb" loading="lazy" referrerpolicy="no-referrer" src="${escapeHtml(item.poster_url)}" onerror="this.src='/api/poster?url=${encodeURIComponent(item.poster_url)}'" alt="" />`
          : `<div class="catalog-thumb"></div>`;
        const year = item.year ? `(${escapeHtml(item.year)})` : "";
        const kind = item.media_type === "series" ? "SERIES" : "MOVIE";
        return `
          <div class="catalog-item ${selected ? "selected" : ""}" data-idx="${idx}">
            <span class="catalog-cursor">${selected ? ">" : " "}</span>
            ${poster}
            <div class="catalog-info">
              <div class="catalog-name">${escapeHtml(item.title)}</div>
              <div class="catalog-sub">${year} <span class="badge">${kind}</span></div>
            </div>
          </div>
        `;
      })
      .join("");

    list.querySelectorAll(".catalog-item").forEach((el) => {
      el.onclick = () => {
        state.selectedIndex = Number(el.dataset.idx);
        renderCatalog();
        openSelectedDetails();
      };
    });

    const activeEl = list.querySelector(".catalog-item.selected");
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }

  async function openSelectedDetails() {
    const item = state.items[state.selectedIndex];
    if (!item) return;

    const provider = item.id?.provider || state.activeProvider;
    const id = item.id?.value;
    if (!id) return;

    setMobileView("details");
    setStatus(`Loading details for "${item.title}"...`);
    $("details-title").textContent = `─ ${item.title} ─`;
    $("details-body").innerHTML = `<div class="empty-state">Loading metadata...</div>`;

    try {
      const details = await apiFetch(
        `/api/details?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(id)}`
      );
      state.currentDetails = details;
      if (details.seasons && details.seasons.length > 0) {
        state.selectedSeason = details.seasons[0].number;
        state.selectedEpisode = details.seasons[0].episodes[0]?.number || 1;
      } else {
        state.selectedSeason = 0;
        state.selectedEpisode = 0;
      }
      renderDetails();
      await loadStreams();
    } catch (e) {
      $("details-body").innerHTML = `<div class="empty-state" style="color:var(--red)">Error: ${escapeHtml(e.message)}</div>`;
      setStatus(`Details error: ${e.message}`);
    }
  }

  function renderDetails() {
    const d = state.currentDetails;
    if (!d) return;

    const poster = d.poster_url
      ? `<img class="details-poster" referrerpolicy="no-referrer" src="${escapeHtml(d.poster_url)}" onerror="this.src='/api/poster?url=${encodeURIComponent(d.poster_url)}'" alt="" />`
      : "";
    const tags = [
      d.year ? `<span class="badge">${escapeHtml(d.year)}</span>` : "",
      d.imdb_rating ? `<span class="badge">IMDb ${escapeHtml(d.imdb_rating)}</span>` : "",
      d.duration ? `<span class="badge">${escapeHtml(d.duration)}</span>` : "",
      ...(d.genres || []).slice(0, 4).map((g) => `<span class="badge">${escapeHtml(g)}</span>`),
    ]
      .filter(Boolean)
      .join("");

    let episodesHtml = "";
    if (d.seasons && d.seasons.length > 0) {
      const seasonsBtns = d.seasons
        .map(
          (s) =>
            `<button class="tui-btn ep-btn ${s.number === state.selectedSeason ? "active" : ""}" data-season="${s.number}">S${s.number}</button>`
        )
        .join("");

      const activeSeasonObj = d.seasons.find((s) => s.number === state.selectedSeason) || d.seasons[0];
      const epBtns = (activeSeasonObj?.episodes || [])
        .map(
          (ep) =>
            `<button class="tui-btn ep-btn ${ep.number === state.selectedEpisode ? "active" : ""}" data-ep="${ep.number}">E${ep.number}</button>`
        )
        .join("");

      episodesHtml = `
        <div class="section-heading">Seasons &amp; Episodes</div>
        <div class="seasons-row">${seasonsBtns}</div>
        <div class="episodes-row">${epBtns}</div>
      `;
    }

    $("details-meta").textContent = d.id?.provider || "";
    $("details-body").innerHTML = `
      <div class="details-hero">
        ${poster}
        <div class="details-info">
          <h2>${escapeHtml(d.title)}</h2>
          <div class="details-tags">${tags}</div>
          <p class="details-desc">${escapeHtml(d.description || "No description available.")}</p>
        </div>
      </div>
      ${episodesHtml}
      <div class="section-heading">Streams &amp; Fast Downloads</div>
      <div id="streams-container" class="streams-list">
        <div class="muted">Resolving available streams...</div>
      </div>
    `;

    $("details-body")
      .querySelectorAll("[data-season]")
      .forEach((btn) => {
        btn.onclick = () => {
          state.selectedSeason = Number(btn.dataset.season);
          const sObj = d.seasons.find((s) => s.number === state.selectedSeason);
          state.selectedEpisode = sObj?.episodes[0]?.number || 1;
          renderDetails();
          loadStreams();
        };
      });

    $("details-body")
      .querySelectorAll("[data-ep]")
      .forEach((btn) => {
        btn.onclick = () => {
          state.selectedEpisode = Number(btn.dataset.ep);
          renderDetails();
          loadStreams();
        };
      });
  }

  function canUseDirectUrl(release) {
    if (!release || release.provider === "fourkhdhub") return null;
    const mirror = release.mirrors?.[0];
    const url = mirror?.resolver_url;
    if (!url) return null;
    const lower = url.toLowerCase();
    if (lower.includes(".mpd") || lower.includes(".m3u8")) return null;
    const hasCookie = (mirror.headers || []).some(
      (h) => String(h[0] || "").toLowerCase() === "cookie"
    );
    return hasCookie ? null : url;
  }

  async function loadStreams() {
    const d = state.currentDetails;
    if (!d) return;
    const provider = d.id?.provider || state.activeProvider;
    const id = d.id?.value;
    const container = $("streams-container");
    if (!container) return;

    container.innerHTML = `<div class="muted">Fetching streams...</div>`;
    setStatus(`Fetching streams for ${d.title}...`);

    try {
      const releases = await apiFetch(
        `/api/streams?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(id)}&season=${state.selectedSeason}&episode=${state.selectedEpisode}`
      );

      if (!releases.length) {
        container.innerHTML = `<div class="muted">No streams found for this selection.</div>`;
        setStatus("No streams found.");
        return;
      }

      container.innerHTML = releases
        .map((rel, idx) => {
          const quality = rel.quality ? `[${escapeHtml(rel.quality)}]` : "";
          const codec = rel.codec ? escapeHtml(rel.codec.toUpperCase()) : "";
          const size = rel.size_bytes ? formatBytes(rel.size_bytes) : "";
          const lang = rel.language ? escapeHtml(rel.language) : "";
          const directUrl = canUseDirectUrl(rel);
          const speedBadge = directUrl ? `<span class="badge">⚡ DIRECT CDN</span>` : "";
          const meta = [quality, codec, lang, size].filter(Boolean).join(" • ");
          const label = rel.filename?.trim() || `${d.title} ${rel.quality || ""}`.trim();
          return `
            <div class="stream-row">
              <div class="stream-meta">
                <div class="stream-title">${escapeHtml(label)} ${speedBadge}</div>
                <div class="stream-sub">${meta || escapeHtml(rel.provider)}</div>
              </div>
              <div class="stream-actions">
                <button class="tui-btn tui-btn-primary" data-stream-idx="${idx}">▶ Stream</button>
                <button class="tui-btn tui-btn-green" data-dl-idx="${idx}">↓ Download</button>
                <button class="tui-btn" data-copy-idx="${idx}" title="Copy direct link for IDM/1DM/VLC">📋</button>
              </div>
            </div>
          `;
        })
        .join("");

      container.querySelectorAll("[data-stream-idx]").forEach((btn) => {
        btn.onclick = () => resolveAndAct(releases[Number(btn.dataset.streamIdx)], "stream");
      });
      container.querySelectorAll("[data-dl-idx]").forEach((btn) => {
        btn.onclick = () => resolveAndAct(releases[Number(btn.dataset.dlIdx)], "download");
      });
      container.querySelectorAll("[data-copy-idx]").forEach((btn) => {
        btn.onclick = () => resolveAndAct(releases[Number(btn.dataset.copyIdx)], "copy");
      });

      setStatus(`Ready: ${releases.length} stream(s) available.`);
    } catch (e) {
      container.innerHTML = `<div style="color:var(--red)">Stream error: ${escapeHtml(e.message)}</div>`;
      setStatus(`Stream error: ${e.message}`);
    }
  }

  function triggerBrowserDownload(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noreferrer";
    if (filename) a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function resolveAndAct(release, mode) {
    const d = state.currentDetails;
    const fallbackName = `${d?.title || "movie"}_${release?.quality || "video"}.mp4`.replace(/\s+/g, "_");
    const filename = release?.filename?.trim() || fallbackName;

    // Fast path: 0ms instant direct CDN URL when no Cookie proxy or 4KHDHub scrape is needed
    const directUrl = canUseDirectUrl(release);
    if (directUrl) {
      if (mode === "download") {
        setStatus(`⚡ Direct CDN download started: ${filename}`);
        triggerBrowserDownload(directUrl, filename);
        return;
      }
      if (mode === "copy") {
        await navigator.clipboard.writeText(directUrl).catch(() => {});
        setStatus("⚡ Direct CDN link copied to clipboard (paste in IDM / 1DM / VLC)!");
        return;
      }
      openPlayer(d?.title || filename, {
        stream_url: directUrl,
        download_url: directUrl,
        is_hls: false,
        is_dash: false,
        filename,
      }, release);
      return;
    }

    setStatus(`Resolving ${mode} link...`);
    try {
      const resolved = await apiFetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ release }),
      });

      if (mode === "download") {
        setStatus(`Starting download: ${resolved.filename || filename}`);
        triggerBrowserDownload(resolved.download_url, resolved.filename || filename);
        return;
      }
      if (mode === "copy") {
        const absUrl = resolved.download_url.startsWith("http")
          ? resolved.download_url
          : `${location.origin}${resolved.download_url}`;
        await navigator.clipboard.writeText(absUrl).catch(() => {});
        setStatus("Link copied to clipboard!");
        return;
      }

      openPlayer(d?.title || resolved.filename || filename, resolved, release);
    } catch (e) {
      setStatus(`Resolve error: ${e.message}`);
    }
  }

  async function openPlayer(title, resolved, release) {
    const modal = $("player-modal");
    const video = $("video-player");
    $("player-title").textContent = `▶ ${title}`;
    $("player-download-link").href = resolved.download_url;
    $("player-download-link").download = resolved.filename || "movie.mp4";
    $("player-subtitles").innerHTML = `<span class="muted">Loading subtitles...</span>`;

    if (state.hlsInstance) {
      state.hlsInstance.destroy();
      state.hlsInstance = null;
    }
    if (state.dashInstance) {
      state.dashInstance.reset();
      state.dashInstance = null;
    }

    video.innerHTML = "";
    video.onerror = () => {
      setStatus("Playback error (codec may be unsupported in browser). Try another stream or tap [↓ Fast Download].");
    };

    if (resolved.is_dash && window.dashjs) {
      const dash = window.dashjs.MediaPlayer().create();
      dash.initialize(video, resolved.stream_url, true);
      state.dashInstance = dash;
    } else if (resolved.is_hls && window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls();
      hls.loadSource(resolved.stream_url);
      hls.attachMedia(video);
      state.hlsInstance = hls;
    } else {
      video.src = resolved.stream_url;
    }

    modal.classList.remove("hidden");
    setStatus(`Streaming: ${title}`);

    if (state.currentDetails?.id?.provider === "moviebox") {
      try {
        const rid = release.resource_id || "";
        const subs = await apiFetch(
          `/api/captions?id=${encodeURIComponent(state.currentDetails.id.value)}&resource_id=${encodeURIComponent(rid)}&season=${state.selectedSeason}&episode=${state.selectedEpisode}`
        );
        if (!subs.length) {
          $("player-subtitles").innerHTML = `<span class="muted">No subtitles found.</span>`;
        } else {
          $("player-subtitles").innerHTML = `<span>Subtitles:</span>`;
          subs.forEach((sub, i) => {
            const track = document.createElement("track");
            track.kind = "subtitles";
            track.label = sub.name;
            track.src = sub.url;
            if (i === 0) track.default = true;
            video.appendChild(track);

            const chip = document.createElement("button");
            chip.className = "tui-btn";
            chip.textContent = sub.name;
            chip.onclick = () => {
              Array.from(video.textTracks).forEach((t, idx) => {
                t.mode = idx === i ? "showing" : "disabled";
              });
            };
            $("player-subtitles").appendChild(chip);
          });
        }
      } catch {
        $("player-subtitles").innerHTML = "";
      }
    } else {
      $("player-subtitles").innerHTML = "";
    }
  }

  function closePlayer() {
    const video = $("video-player");
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (state.hlsInstance) {
      state.hlsInstance.destroy();
      state.hlsInstance = null;
    }
    if (state.dashInstance) {
      state.dashInstance.reset();
      state.dashInstance = null;
    }
    $("player-modal").classList.add("hidden");
  }

  async function refreshUpdaterStatus() {
    try {
      const st = await apiFetch("/api/updater/status");
      const btn = $("btn-updater");
      btn.classList.remove("busy", "err");
      if (st.state === "checking" || st.state === "pulling" || st.state === "building" || st.state === "restarting") {
        btn.classList.add("busy");
      } else if (st.state === "error") {
        btn.classList.add("err");
      }
      const commit = st.current_commit ? `@${st.current_commit}` : "";
      $("updater-label").textContent = `sync: ${st.state} ${commit}`.trim();
    } catch {
      // ignore if logged out
    }
  }

  async function triggerUpdateCheck() {
    setStatus("Checking MovieBox-TUI repo for updates...");
    $("btn-updater").classList.add("busy");
    $("updater-label").textContent = "sync: checking...";
    try {
      const res = await apiFetch("/api/updater/check", { method: "POST" });
      await refreshUpdaterStatus();
      if (res.updated) {
        setStatus("Update pulled & rebuilt! Server is restarting...");
      } else if (res.error) {
        setStatus(`Update check error: ${res.error}`);
      } else {
        setStatus("MovieBox-TUI is already up to date.");
      }
    } catch (e) {
      setStatus(`Update check failed: ${e.message}`);
    }
  }

  // Event listeners
  $("gate-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const passcode = $("gate-input").value;
    $("gate-error").textContent = "";
    try {
      await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      await initApp();
    } catch (err) {
      $("gate-error").textContent = err.message || "Invalid passphrase";
      $("gate-input").select();
    }
  });

  $("btn-logout").onclick = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    showGate();
  };

  $("theme-select").onchange = (e) => applyTheme(e.target.value);
  $("btn-updater").onclick = triggerUpdateCheck;
  $("btn-home").onclick = () => {
    $("search-input").value = "";
    loadHomepage();
  };
  $("btn-search").onclick = () => performSearch($("search-input").value);
  $("btn-close-player").onclick = closePlayer;
  $("btn-help").onclick = () => $("help-modal").classList.remove("hidden");
  $("btn-close-help").onclick = () => $("help-modal").classList.add("hidden");

  $("tab-mobile-catalog").onclick = () => setMobileView("catalog");
  $("tab-mobile-details").onclick = () => setMobileView("details");
  $("btn-mobile-back").onclick = () => setMobileView("catalog");

  let suggestTimer = null;
  $("search-input").addEventListener("input", () => {
    clearTimeout(suggestTimer);
    const q = $("search-input").value.trim();
    if (q.length < 2 || state.activeProvider !== "moviebox") {
      $("suggest-box").classList.add("hidden");
      return;
    }
    suggestTimer = setTimeout(async () => {
      try {
        const list = await apiFetch(`/api/suggest?q=${encodeURIComponent(q)}`);
        if (!list.length) {
          $("suggest-box").classList.add("hidden");
          return;
        }
        $("suggest-box").innerHTML = list
          .slice(0, 8)
          .map((s) => `<div class="suggest-item">${escapeHtml(s)}</div>`)
          .join("");
        $("suggest-box").classList.remove("hidden");
        $("suggest-box")
          .querySelectorAll(".suggest-item")
          .forEach((el) => {
            el.onclick = () => {
              $("search-input").value = el.textContent;
              $("suggest-box").classList.add("hidden");
              performSearch(el.textContent);
            };
          });
      } catch {
        $("suggest-box").classList.add("hidden");
      }
    }, 220);
  });

  $("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      performSearch($("search-input").value);
    } else if (e.key === "Escape") {
      $("suggest-box").classList.add("hidden");
      $("search-input").blur();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (!$("gate-screen").classList.contains("hidden")) return;

    const tag = document.activeElement?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

    if (e.key === "Escape") {
      if (!$("player-modal").classList.contains("hidden")) {
        closePlayer();
      } else if (!$("help-modal").classList.contains("hidden")) {
        $("help-modal").classList.add("hidden");
      } else if ($("tui-workspace")?.getAttribute("data-mobile-view") === "details") {
        setMobileView("catalog");
      } else {
        $("suggest-box").classList.add("hidden");
      }
      return;
    }

    if (typing) return;

    if (e.key === "/") {
      e.preventDefault();
      $("search-input").focus();
    } else if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      if (state.items.length) {
        state.selectedIndex = Math.min(state.items.length - 1, state.selectedIndex + 1);
        renderCatalog();
      }
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      if (state.items.length) {
        state.selectedIndex = Math.max(0, state.selectedIndex - 1);
        renderCatalog();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      openSelectedDetails();
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (state.providers.length) {
        const idx = state.providers.findIndex((p) => p.id === state.activeProvider);
        const next = state.providers[(idx + 1) % state.providers.length];
        state.activeProvider = next.id;
        renderProviders();
      }
    } else if (e.key === "t") {
      const cur = localStorage.getItem("mb_theme") || "mocha";
      const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
      applyTheme(next);
      setStatus(`Theme: ${next}`);
    } else if (e.key === "u") {
      triggerUpdateCheck();
    } else if (e.key === "?") {
      $("help-modal").classList.toggle("hidden");
    }
  });

  // Boot
  applyTheme(localStorage.getItem("mb_theme") || "mocha");
  fetch("/api/auth/check")
    .then((r) => r.json())
    .then((data) => {
      if (data.authenticated) {
        initApp();
      } else {
        showGate();
      }
    })
    .catch(showGate);

  setInterval(refreshUpdaterStatus, 30000);
})();
