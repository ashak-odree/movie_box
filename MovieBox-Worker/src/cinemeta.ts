// 100% self-sufficient Cinemeta + Multi-Server Stream provider for Cloudflare Workers
// Zero tunnel, zero local server required, 24/7 uptime on Cloudflare Edge.

const CINEMETA = "https://v3-cinemeta.strem.io";

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "MovieBox-TUI-Web/1.0",
      Accept: "application/json",
    },
  });
  if (!r.ok) throw new Error(`Cinemeta HTTP ${r.status}`);
  return r.json();
}

function adaptMetaToCatalog(m: any, defaultType: "movie" | "series" = "movie") {
  const id = String(m?.imdb_id || m?.id || "");
  const title = String(m?.name || "").trim();
  if (!id || !title) return null;
  const type = m?.type === "series" ? "series" : defaultType;
  const yearMatch = String(m?.releaseInfo || m?.year || "").match(/\d{4}/);
  return {
    id: { provider: type === "series" ? "series" : "movies", value: `${type}:${id}` },
    title,
    media_type: type,
    year: yearMatch ? yearMatch[0] : null,
    poster_url: m?.poster || `https://images.metahub.space/poster/small/${id}/img`,
    season_count: null,
  };
}

export async function getCinemetaHomepage(provider = "movies", page = 1) {
  const isSeries = provider === "series";
  const skip = (Math.max(1, page) - 1) * 30;
  const type = isSeries ? "series" : "movie";
  const url =
    skip > 0
      ? `${CINEMETA}/catalog/${type}/top/skip=${skip}.json`
      : `${CINEMETA}/catalog/${type}/top.json`;

  const data = await fetchJson(url);
  const items = (data?.metas || [])
    .slice(0, 40)
    .map((m: any) => adaptMetaToCatalog(m, type))
    .filter(Boolean);
  return { items, page };
}

export async function searchCinemeta(query: string, provider = "all", page = 1) {
  const q = encodeURIComponent(query.trim());
  const tasks: Promise<any[]>[] = [];

  if (provider === "all" || provider === "movies" || provider === "moviebox") {
    tasks.push(
      fetchJson(`${CINEMETA}/catalog/movie/top/search=${q}.json`)
        .then((d) => (d?.metas || []).map((m: any) => adaptMetaToCatalog(m, "movie")).filter(Boolean))
        .catch(() => [])
    );
  }
  if (provider === "all" || provider === "series" || provider === "moviebox") {
    tasks.push(
      fetchJson(`${CINEMETA}/catalog/series/top/search=${q}.json`)
        .then((d) => (d?.metas || []).map((m: any) => adaptMetaToCatalog(m, "series")).filter(Boolean))
        .catch(() => [])
    );
  }

  const parts = await Promise.all(tasks);
  // Interleave movies and series when searching all
  const merged: any[] = [];
  const maxLen = Math.max(0, ...parts.map((p) => p.length));
  for (let i = 0; i < maxLen; i++) {
    for (const p of parts) {
      if (p[i]) merged.push(p[i]);
    }
  }
  return { provider, page, items: merged.slice(0, 40) };
}

export async function suggestCinemeta(query: string): Promise<string[]> {
  const res = await searchCinemeta(query, "all", 1);
  return (res.items || []).slice(0, 8).map((x: any) => x.title);
}

export async function getCinemetaDetails(rawId: string) {
  let type: "movie" | "series" = "movie";
  let imdbId = rawId;
  if (rawId.includes(":")) {
    const [t, rest] = rawId.split(":", 2);
    if (t === "series") type = "series";
    imdbId = rest;
  }

  const data = await fetchJson(`${CINEMETA}/meta/${type}/${encodeURIComponent(imdbId)}.json`);
  const m = data?.meta || {};

  const seasonMap = new Map<number, any[]>();
  for (const v of m?.videos || []) {
    const se = Number(v?.season ?? 0);
    const ep = Number(v?.episode ?? v?.number ?? 0);
    if (se <= 0 || ep <= 0) continue;
    if (!seasonMap.has(se)) seasonMap.set(se, []);
    seasonMap.get(se)!.push({
      season: se,
      number: ep,
      title: v?.name || v?.title || `Episode ${ep}`,
      overview: v?.overview || null,
    });
  }

  const seasons = Array.from(seasonMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([num, eps]) => ({
      number: num,
      episodes: eps.sort((a, b) => a.number - b.number),
    }));

  const yearMatch = String(m?.releaseInfo || m?.year || "").match(/\d{4}/);

  return {
    id: { provider: type === "series" ? "series" : "movies", value: `${type}:${imdbId}` },
    title: String(m?.name || "Unknown"),
    media_type: type,
    year: yearMatch ? yearMatch[0] : null,
    description: m?.description || null,
    tagline: null,
    imdb_rating: m?.imdbRating ? String(m.imdbRating) : null,
    director: Array.isArray(m?.director) ? m.director.join(", ") : null,
    stars: Array.isArray(m?.cast) ? m.cast.slice(0, 5).join(", ") : null,
    prints: null,
    audios: null,
    poster_url: m?.poster || `https://images.metahub.space/poster/medium/${imdbId}/img`,
    duration: m?.runtime || null,
    genres: Array.isArray(m?.genres) ? m.genres : [],
    seasons,
    dubs: [],
  };
}

export function getEmbedStreams(rawId: string, season = 0, episode = 0) {
  let type: "movie" | "series" = "movie";
  let imdbId = rawId;
  if (rawId.includes(":")) {
    const [t, rest] = rawId.split(":", 2);
    if (t === "series") type = "series";
    imdbId = rest;
  }

  const isTv = type === "series" || (season > 0 && episode > 0);
  const s = Math.max(1, season || 1);
  const e = Math.max(1, episode || 1);
  const tag = isTv ? `S${s}E${e}` : "Full Movie";

  const servers = [
    {
      name: `Server 1 · VidSrc.su (${tag})`,
      quality: "1080p",
      url: isTv
        ? `https://vidsrc.su/embed/tv/${imdbId}/${s}/${e}`
        : `https://vidsrc.su/embed/movie/${imdbId}`,
    },
    {
      name: `Server 2 · MultiEmbed (${tag})`,
      quality: "1080p",
      url: isTv
        ? `https://multiembed.mov/?video_id=${imdbId}&s=${s}&e=${e}`
        : `https://multiembed.mov/?video_id=${imdbId}`,
    },
    {
      name: `Server 3 · AutoEmbed (${tag})`,
      quality: "1080p",
      url: isTv
        ? `https://autoembed.co/tv/imdb/${imdbId}-${s}-${e}`
        : `https://autoembed.co/movie/imdb/${imdbId}`,
    },
    {
      name: `Server 4 · 2Embed (${tag})`,
      quality: "1080p",
      url: isTv
        ? `https://www.2embed.cc/embedtv/${imdbId}&s=${s}&e=${e}`
        : `https://www.2embed.cc/embed/${imdbId}`,
    },
    {
      name: `Server 5 · VidSrc.in (${tag})`,
      quality: "1080p",
      url: isTv
        ? `https://vidsrc.in/embed/tv?imdb=${imdbId}&season=${s}&episode=${e}`
        : `https://vidsrc.in/embed/movie?imdb=${imdbId}`,
    },
  ];

  return servers.map((srv) => ({
    provider: "embed",
    filename: srv.name,
    quality: srv.quality,
    codec: "h264",
    language: "Multi-Sub",
    size_bytes: null,
    season: isTv ? s : 0,
    episode: isTv ? e : 0,
    resource_id: imdbId,
    mirrors: [
      {
        label: srv.name,
        resolver_url: srv.url,
        headers: [],
        direct_file: false,
      },
    ],
  }));
}

