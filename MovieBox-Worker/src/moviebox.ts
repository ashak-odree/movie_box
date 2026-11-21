// Pure-JS MD5 & HMAC-MD5 for MovieBox API signing in Cloudflare Workers

const SECRET_BYTES = new Uint8Array([
  0xef, 0xa8, 0x91, 0x97, 0x4e, 0xec, 0xd3, 0x14, 0x8d, 0xf6, 0x3a, 0xa6, 0x11,
  0x60, 0x2d, 0xef, 0xd1, 0x01, 0x25, 0x9b, 0xa5, 0x21, 0x02, 0x2c, 0x57, 0xae,
  0x05, 0x66, 0xbd, 0x8e,
]);

const STOCK_CERT_SHA256 =
  "03d4b741632d136bc23e2de4c6adcdb7712f1980b619c183221801730bbd0410";
const BUILD_TAG_SALT = "oneroom";

const HOST_POOL = [
  "https://api6.aoneroom.com",
  "https://api5.aoneroom.com",
  "https://api4.aoneroom.com",
  "https://api4sg.aoneroom.com",
  "https://api3.aoneroom.com",
  "https://api6sg.aoneroom.com",
  "https://api.inmoviebox.com",
];

// Compact RFC 1321 MD5 implementation operating on Uint8Array
function md5Raw(msg: Uint8Array): Uint8Array {
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
    9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
    16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
    15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  }

  const origLen = msg.length;
  const padLen = ((56 - ((origLen + 1) % 64)) + 64) % 64;
  const totalLen = origLen + 1 + padLen + 8;
  const buf = new Uint8Array(totalLen);
  buf.set(msg);
  buf[origLen] = 0x80;

  const bitLen = origLen * 8;
  const view = new DataView(buf.buffer);
  view.setUint32(totalLen - 8, bitLen >>> 0, true);
  view.setUint32(totalLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < totalLen; offset += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) {
      M[j] = view.getUint32(offset + j * 4, true);
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F = 0;
      let g = 0;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }

      const temp = (A + F + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      const rot = s[i];
      B = (B + ((temp << rot) | (temp >>> (32 - rot)))) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

function md5Hex(input: string | Uint8Array): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = md5Raw(bytes);
  return Array.from(digest)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hmacMd5(key: Uint8Array, data: Uint8Array): Uint8Array {
  const blockSize = 64;
  const k = key.length > blockSize ? md5Raw(key) : key;
  const oPad = new Uint8Array(blockSize);
  const iPad = new Uint8Array(blockSize);
  oPad.fill(0x5c);
  iPad.fill(0x36);
  for (let i = 0; i < k.length; i++) {
    oPad[i] ^= k[i];
    iPad[i] ^= k[i];
  }
  const inner = new Uint8Array(blockSize + data.length);
  inner.set(iPad);
  inner.set(data, blockSize);
  const innerHash = md5Raw(inner);

  const outer = new Uint8Array(blockSize + 16);
  outer.set(oPad);
  outer.set(innerHash, blockSize);
  return md5Raw(outer);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function generateClientToken(ts: number): string {
  const tsStr = String(ts);
  const rev = tsStr.split("").reverse().join("");
  return `${tsStr},${md5Hex(rev)}`;
}

function generateClientBuild(tsMs: number): string {
  const randPart = Math.floor(Math.random() * 1000);
  const stamp = `${Math.floor(tsMs / 1000)}${String(tsMs % 1000).padStart(3, "0")}000${randPart}`;
  const hash = md5Hex(`${STOCK_CERT_SHA256}${BUILD_TAG_SALT}${stamp}`);
  return `${stamp}.${hash}`;
}

function sortedQueryString(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const entries = Array.from(u.searchParams.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    return entries.map(([k, v]) => `${k}=${v}`).join("&");
  } catch {
    return "";
  }
}

function generateTrSignature(
  method: string,
  url: string,
  body: string | undefined,
  tsMs: number
): string {
  const u = new URL(url);
  const qs = sortedQueryString(url);
  const canonicalUrl = qs ? `${u.pathname}?${qs}` : u.pathname;
  let bodyHash = "";
  let bodyLen = "";
  if (body !== undefined) {
    const bytes = new TextEncoder().encode(body);
    bodyLen = String(bytes.length);
    const slice = bytes.length > 102400 ? bytes.slice(0, 102400) : bytes;
    bodyHash = md5Hex(slice);
  }
  const canonical = `${method.toUpperCase()}\napplication/json\napplication/json\n${bodyLen}\n${tsMs}\n${bodyHash}\n${canonicalUrl}`;
  const sig = hmacMd5(SECRET_BYTES, new TextEncoder().encode(canonical));
  return `${tsMs}|2|${toBase64(sig)}`;
}

function buildHeaders(
  method: string,
  url: string,
  body: string | undefined,
  token: string | null
): Record<string, string> {
  const ts = Date.now();
  const buildTag = generateClientBuild(ts);
  const versionCode = 50020117;
  const clientInfo = JSON.stringify({
    package_name: "com.community.oneroom",
    version_name: "4.0.01.0813.03",
    version_code: versionCode,
    os: "android",
    os_version: "13",
    install_ch: "ps",
    device_id: "a1b2c3d4e5f60708a1b2c3d4e5f60708",
    install_store: "ps",
    gaid: "a1b2c3d4-e5f6-4708-9012-a1b2c3d4e5f6",
    brand: "Redmi",
    model: "23078RKD5C",
    system_language: "en",
    net: "NETWORK_WIFI",
    region: "US",
    timezone: "Asia/Kolkata",
    sp_code: "40401",
    "X-Play-Mode": "2",
    "X-Client-Build": buildTag,
  });

  const headers: Record<string, string> = {
    "User-Agent": `com.community.oneroom/${versionCode} (Linux; U; Android 13; en_US; 23078RKD5C; Build/TQ2A.230405.003; Cronet/135.0.7012.3)`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-client-token": generateClientToken(ts),
    "x-tr-signature": generateTrSignature(method, url, body, ts),
    "x-client-build": buildTag,
    "x-client-info": clientInfo,
    "x-client-status": "0",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

let cachedToken: string | null = null;

async function requestMovieBox(
  method: string,
  path: string,
  body?: unknown,
  token?: string | null
): Promise<any> {
  const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
  const errors: string[] = [];

  for (const host of HOST_POOL) {
    const url = `${host}${path}`;
    try {
      const resp = await fetch(url, {
        method,
        headers: buildHeaders(method, url, bodyStr, token ?? null),
        body: bodyStr,
      });
      if (!resp.ok) {
        errors.push(`${host}->${resp.status}`);
        continue;
      }
      const json: any = await resp.json();
      if (json && typeof json === "object" && "data" in json) {
        return json.data ?? json;
      }
      return json;
    } catch (e: any) {
      errors.push(`${host}->${e?.message || "err"}`);
    }
  }
  throw new Error(`MovieBox hosts failed: ${errors.join(", ")}`);
}

async function ensureToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  try {
    const data = await requestMovieBox(
      "POST",
      "/wefeed-mobile-bff/user-api/visitor-login",
      {},
      null
    );
    if (data?.token) {
      cachedToken = data.token;
      return cachedToken;
    }
  } catch {
    // Some endpoints also work without visitor token
  }
  return null;
}

function adaptSubject(s: any): any | null {
  const id = String(s?.subjectId ?? s?.id ?? "");
  const title = String(s?.title ?? s?.name ?? "").trim();
  if (!id || !title) return null;
  const st = Number(s?.subjectType ?? s?.type ?? 1);
  return {
    id: { provider: "moviebox", value: id },
    title,
    media_type: st === 2 ? "series" : "movie",
    year: s?.releaseDate ? String(s.releaseDate).slice(0, 4) : null,
    poster_url: s?.cover?.url || s?.poster || null,
    season_count: null,
  };
}

export async function getHomepage(page = 1) {
  const token = await ensureToken();
  const data = await requestMovieBox(
    "GET",
    `/wefeed-mobile-bff/tab-operating?page=${page}&tabId=&version=`,
    undefined,
    token
  );
  const items: any[] = [];
  const seen = new Set<string>();
  const lists = data?.operatingList || data?.items || [];
  for (const block of lists) {
    const subjects = block?.subjects || block?.banner?.items || (block?.subjectId ? [block] : []);
    for (const s of subjects) {
      const sub = s?.subject || s;
      const item = adaptSubject(sub);
      if (item && !seen.has(item.id.value)) {
        seen.add(item.id.value);
        items.push(item);
      }
    }
  }
  return { items, page };
}

export async function searchMovieBox(query: string, page = 1) {
  const token = await ensureToken();
  const data = await requestMovieBox(
    "POST",
    "/wefeed-mobile-bff/subject-api/search/v2",
    { keyword: query, page, perPage: 15, subjectType: 0 },
    token
  );
  const raw = data?.items || data?.subjects || [];
  const items = raw.map(adaptSubject).filter(Boolean);
  return { provider: "moviebox", page, items };
}

export async function suggestMovieBox(query: string): Promise<string[]> {
  const res = await searchMovieBox(query, 1);
  return (res.items || []).map((x: any) => String(x?.title || "")).filter(Boolean);
}

export async function getDetails(id: string) {
  const token = await ensureToken();
  const data = await requestMovieBox(
    "GET",
    `/wefeed-mobile-bff/subject-api/get?subjectId=${encodeURIComponent(id)}`,
    undefined,
    token
  );
  const s = data?.subject || data || {};
  const stype = Number(s?.subjectType ?? data?.subjectType ?? 1);
  let seasonsRaw = data?.resource?.seasons || s?.seasons || [];
  if (stype === 2 && seasonsRaw.length === 0) {
    const seasonInfo = await requestMovieBox(
      "GET",
      `/wefeed-mobile-bff/subject-api/season-info?subjectId=${encodeURIComponent(id)}`,
      undefined,
      token
    ).catch(() => null);
    seasonsRaw = seasonInfo?.seasons || (Array.isArray(seasonInfo) ? seasonInfo : []);
  }
  const seasons = seasonsRaw.map((se: any) => {
    const num = Number(se?.se ?? se?.season ?? 1);
    const maxEp = Number(se?.maxEp ?? se?.episodes?.length ?? 1);
    const episodes = Array.from({ length: maxEp }, (_, idx) => ({
      season: num,
      number: idx + 1,
      title: `Episode ${idx + 1}`,
      overview: null,
    }));
    return { number: num, episodes };
  });

  const genres = String(s?.genre || "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);

  return {
    id: { provider: "moviebox", value: id },
    title: String(s?.title || "Unknown"),
    media_type: seasons.length > 0 || Number(s?.subjectType) === 2 ? "series" : "movie",
    year: s?.releaseDate ? String(s.releaseDate).slice(0, 4) : null,
    description: s?.description || null,
    tagline: null,
    imdb_rating: s?.imdbRatingValue ? String(s.imdbRatingValue) : null,
    director: null,
    stars: null,
    prints: null,
    audios: null,
    poster_url: s?.cover?.url || null,
    duration: s?.duration ? `${Math.round(Number(s.duration) / 60)}m` : null,
    genres,
    seasons,
    dubs: [],
  };
}

export async function getStreams(id: string, season = 0, episode = 0) {
  const token = await ensureToken();
  const seQuery = season > 0 || episode > 0 ? `&se=${season}&ep=${episode}` : "";

  const [resData, playData] = await Promise.all([
    requestMovieBox(
      "GET",
      `/wefeed-mobile-bff/subject-api/resource?subjectId=${encodeURIComponent(id)}${seQuery}&page=1&perPage=20`,
      undefined,
      token
    ).catch(() => null),
    requestMovieBox(
      "GET",
      `/wefeed-mobile-bff/subject-api/play-info/v2?subjectId=${encodeURIComponent(id)}${seQuery}`,
      undefined,
      token
    ).catch(() => null),
  ]);

  const releases: any[] = [];

  const resList = resData?.list || resData?.items || [];
  for (const item of resList) {
    const url = item?.url || item?.downloadUrl;
    if (!url) continue;
    releases.push({
      provider: "moviebox",
      filename: item?.name || item?.title || `stream_${item?.resolution || "hd"}.mp4`,
      quality: item?.resolution ? `${item.resolution}p` : null,
      codec: item?.codec || null,
      language: item?.language || null,
      size_bytes: item?.size ? Number(item.size) : null,
      season: item?.se ?? season,
      episode: item?.ep ?? episode,
      resource_id: item?.resourceId ? String(item.resourceId) : null,
      mirrors: [
        {
          label: item?.resolution ? `${item.resolution}p Direct` : "Direct MP4",
          resolver_url: url,
          headers: [],
          direct_file: true,
        },
      ],
    });
  }

  const streams = playData?.streams || [];
  for (const st of streams) {
    const url = st?.url;
    if (!url) continue;
    const hdrs: [string, string][] = [];
    if (st?.signCookie) {
      hdrs.push(["Referer", "https://sportslive.wine"]);
      hdrs.push(["User-Agent", "MovieBox-Tui/0.1.30"]);
      hdrs.push(["Cookie", st.signCookie]);
    }
    releases.push({
      provider: "moviebox",
      filename: `${playData?.title || "stream"} ${st?.resolutions || ""}`.trim(),
      quality: st?.resolutions ? `${st.resolutions}p` : null,
      codec: st?.codecName || null,
      language: null,
      size_bytes: st?.size ? Number(st.size) : null,
      season,
      episode,
      resource_id: st?.id ? String(st.id) : null,
      mirrors: [
        {
          label: `${st?.resolutions || "Stream"} ${st?.codecName || ""}`.trim(),
          resolver_url: url,
          headers: hdrs,
          direct_file: true,
        },
      ],
    });
  }

  releases.sort((a, b) => {
    const aMpd = (a.mirrors[0]?.resolver_url || "").toLowerCase().includes(".mpd") ? 1 : 0;
    const bMpd = (b.mirrors[0]?.resolver_url || "").toLowerCase().includes(".mpd") ? 1 : 0;
    return aMpd - bMpd;
  });

  return releases;
}

export async function getCaptions(id: string, resourceId: string) {
  if (!resourceId) return [];
  const token = await ensureToken();
  const data = await requestMovieBox(
    "GET",
    `/wefeed-mobile-bff/subject-api/get-ext-captions?subjectId=${encodeURIComponent(id)}&resourceId=${encodeURIComponent(resourceId)}`,
    undefined,
    token
  ).catch(() => null);
  const list = data?.extCaptions || [];
  return list
    .filter((c: any) => c?.url)
    .map((c: any) => ({
      name: c.lanName || c.lan || "Subtitle",
      url: c.url,
    }));
}

