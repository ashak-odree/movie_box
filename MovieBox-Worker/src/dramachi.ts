// Dramachi provider (api.nodeobjects.com) ported from MovieBox-TUI for Cloudflare Workers
// Provides direct MP4/MKV streaming (in Plyr) & direct file downloads — zero tunnel!

const BASE = "https://api.nodeobjects.com/";
const IMG_CDN = "https://static.nodeobjects.com/thumbnail/";

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url, {
    headers: { "User-Agent": "MovieBox-Tui/0.1.30", Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Dramachi HTTP ${r.status}`);
  return r.json();
}

function posterUrl(thumb?: string | null): string | null {
  if (!thumb) return null;
  if (thumb.startsWith("http")) return thumb;
  return `${IMG_CDN}${thumb.replace(/^\/+/, "")}`;
}

function parseEpNum(title?: string | null): number {
  if (!title) return 0;
  const m = title.match(/(?:ep|e|episode)[\s._-]*0*(\d+)/i) || title.match(/\b0*(\d+)\b/);
  return m ? Number(m[1]) : 0;
}

export async function searchDramachi(query: string, page = 1) {
  const q = query.trim();
  if (!q) return { provider: "dramachi", page, items: [] };
  const data = await fetchJson(
    `${BASE}?interface=search&q=${encodeURIComponent(q)}&filter=all&page=${Math.max(1, page)}`
  );
  const items = (data?.data || []).map((item: any) => {
    const content = String(item?.content || "").toLowerCase();
    const isMovie = content === "movies" || content === "movie";
    const id = String(item?.id ?? "");
    const title = String(item?.title || item?.name || "").trim();
    if (!id || !title) return null;
    return {
      id: { provider: "dramachi", value: id },
      title,
      media_type: isMovie ? "movie" : "series",
      year: item?.year ? String(item.year) : null,
      poster_url: posterUrl(item?.thumbnail || item?.poster),
      season_count: null,
    };
  }).filter(Boolean);
  return { provider: "dramachi", page, items };
}

export async function getDramachiTrending() {
  // Fetch popular dramas/movies via a broad popular query
  return searchDramachi("love", 1);
}

export async function getDramachiDetails(id: string) {
  const titleId = id.split("::")[0].trim();
  const data = await fetchJson(`${BASE}?interface=title_v2&id=${encodeURIComponent(titleId)}`);
  const info = data?.info || data?.data || data || {};
  const seasonsObj = data?.seasons || {};
  const seasons: any[] = [];

  for (const [key, group] of Object.entries(seasonsObj)) {
    const numMatch = key.match(/(\d+)/);
    const sNum = numMatch ? Number(numMatch[1]) : seasons.length + 1;
    const arr = Array.isArray(group) ? group : [];
    const firstRip = arr[0]?.rip || arr[0]?.season || key;
    let episodes: any[] = [];
    if (firstRip) {
      try {
        const epData = await fetchJson(
          `${BASE}?interface=eplist&season=${encodeURIComponent(firstRip)}&id=${encodeURIComponent(titleId)}`
        );
        const list = epData?.episodeList || epData?.episode_list || [];
        episodes = list
          .map((ep: any, idx: number) => ({
            season: sNum,
            number: parseEpNum(ep?.f_title || ep?.title) || idx + 1,
            title: ep?.f_title || ep?.title || `Episode ${idx + 1}`,
            overview: null,
          }))
          .sort((a: any, b: any) => a.number - b.number);
      } catch {
        episodes = [{ season: sNum, number: 1, title: "Episode 1", overview: null }];
      }
    }
    seasons.push({ number: sNum, episodes });
  }
  seasons.sort((a, b) => a.number - b.number);

  return {
    id: { provider: "dramachi", value: titleId },
    title: String(info?.title || info?.name || "Unknown"),
    media_type: seasons.length > 0 ? "series" : "movie",
    year: info?.year ? String(info.year) : null,
    description: info?.description || info?.synopsis || info?.plot || null,
    tagline: null,
    imdb_rating: info?.rating ? String(info.rating) : null,
    director: null,
    stars: null,
    prints: null,
    audios: null,
    poster_url: posterUrl(info?.thumbnail || info?.poster),
    duration: info?.duration ? String(info.duration) : null,
    genres: Array.isArray(info?.genres) ? info.genres : [],
    seasons,
    dubs: [],
  };
}

export async function getDramachiStreams(id: string, season = 0, episode = 0) {
  const titleId = id.split("::")[0].trim();
  const data = await fetchJson(`${BASE}?interface=title_v2&id=${encodeURIComponent(titleId)}`);
  const seasonsObj = data?.seasons || {};
  const rips: string[] = [];

  if (season > 0) {
    const key = `Season ${String(season).padStart(2, "0")}`;
    const group = seasonsObj[key] || Object.values(seasonsObj)[season - 1] || [];
    for (const item of Array.isArray(group) ? group : []) {
      const r = item?.rip || item?.season;
      if (r && !rips.includes(r)) rips.push(r);
    }
  } else {
    for (const group of Object.values(seasonsObj)) {
      for (const item of Array.isArray(group) ? group : []) {
        const r = item?.rip || item?.season;
        if (r && !rips.includes(r)) rips.push(r);
      }
    }
  }

  const releases: any[] = [];
  for (const rip of rips.slice(0, 4)) {
    try {
      const epData = await fetchJson(
        `${BASE}?interface=eplist&season=${encodeURIComponent(rip)}&id=${encodeURIComponent(titleId)}`
      );
      const list = epData?.episodeList || epData?.episode_list || [];
      const targetEp =
        episode > 0
          ? list.find((e: any, idx: number) => (parseEpNum(e?.f_title || e?.title) || idx + 1) === episode) || list[episode - 1]
          : list[0];
      if (!targetEp) continue;

      const fid = String(targetEp?.fid ?? targetEp?.id ?? "");
      const disk = String(targetEp?.disk ?? targetEp?.findex ?? "0");
      if (!fid) continue;

      const fData = await fetchJson(
        `${BASE}?interface=getFile&fid=${encodeURIComponent(fid)}&findex=${encodeURIComponent(disk)}`
      );
      const host = fData?.hostInfo?.host || fData?.host_info?.host;
      const fi = (fData?.fileInfo || fData?.file_info || [])[0];
      const rawUrl = fi?.url;
      if (!host || !rawUrl) continue;

      const streamUrl = `https://${String(host).replace(/\/+$/, "")}/cdn/${String(rawUrl).replace(/^\/+/, "")}`;
      const filename = fi?.filename || fi?.f_title || `${rip}.mp4`;
      const qMatch = filename.match(/(2160p|1080p|720p|480p|360p)/i);

      releases.push({
        provider: "dramachi",
        filename,
        quality: qMatch ? qMatch[1] : "HD",
        codec: /265|hevc/i.test(filename) ? "hevc" : "h264",
        language: null,
        size_bytes: fi?.size ? Number(fi.size) : null,
        season,
        episode,
        resource_id: fid,
        mirrors: [
          {
            label: `${rip} Direct`,
            resolver_url: streamUrl,
            headers: [],
            direct_file: true,
          },
        ],
      });
    } catch {
      // skip failing rip
    }
  }

  return releases;
}
