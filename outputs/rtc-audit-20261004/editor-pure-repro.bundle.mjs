// src/lib/id.ts
var counter = 0;
function genId(prefix) {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${counter}-${rand}`;
}

// src/types/rtc.ts
var DEFAULT_RTC_TRANSFORM = {
  scaleX: 1,
  scaleY: 1,
  x: 0,
  y: 0,
  rotation: 0,
  opacity: 1
};
function segTransform(seg2) {
  const t = seg2.transform;
  if (!t) return DEFAULT_RTC_TRANSFORM;
  const num = (v, d2) => typeof v === "number" && Number.isFinite(v) ? v : d2;
  return {
    scaleX: num(t.scaleX, 1),
    scaleY: num(t.scaleY, 1),
    x: num(t.x, 0),
    y: num(t.y, 0),
    rotation: num(t.rotation, 0),
    opacity: Math.min(1, Math.max(0, num(t.opacity, 1))),
    ...t.flipH ? { flipH: true } : {},
    ...t.flipV ? { flipV: true } : {}
  };
}

// src/lib/rtcTransformCore.ts
var SCALE_MIN = 0.01;
var SCALE_MAX = 20;
var POS_RATIO_LIMIT = 5;
var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
var z = (n) => n === 0 ? 0 : n;
var round = (n, digits = 6) => {
  const f = 10 ** digits;
  return z(Math.round(n * f) / f);
};
function clampScale(v) {
  return Number.isFinite(v) ? round(clamp(v, SCALE_MIN, SCALE_MAX), 4) : 1;
}
function clampOpacity(v) {
  return Number.isFinite(v) ? round(clamp(v, 0, 1), 4) : 1;
}
function clampPosRatio(v) {
  return Number.isFinite(v) ? round(clamp(v, -POS_RATIO_LIMIT, POS_RATIO_LIMIT)) : 0;
}
function normalizeRotation(deg) {
  if (!Number.isFinite(deg)) return 0;
  const wrapped = (deg % 360 + 360) % 360;
  const r = round(wrapped, 2);
  return r >= 360 ? 0 : z(r);
}
function toJyClip(t) {
  return {
    alpha: round(clampOpacity(t.opacity)),
    flip: { horizontal: !!t.flipH, vertical: !!t.flipV },
    rotation: round(normalizeRotation(t.rotation), 2),
    scale: { x: round(clampScale(t.scaleX)), y: round(clampScale(t.scaleY)) },
    transform: { x: round(clampPosRatio(t.x) * 2), y: round(-clampPosRatio(t.y) * 2) }
  };
}
function jyUniformScaleOn(t) {
  return clampScale(t.scaleX) === clampScale(t.scaleY);
}

// src/lib/rtcKeyframes.ts
var RTC_KF_PROPS = ["x", "y", "scale", "rotation", "opacity", "volume"];
var clamp01 = (v) => Math.min(1, Math.max(0, v));
function clampKfValue(prop, v) {
  if (!Number.isFinite(v)) return prop === "scale" ? 1 : prop === "opacity" || prop === "volume" ? 1 : 0;
  switch (prop) {
    case "x":
    case "y":
      return clampPosRatio(v);
    case "scale":
      return clampScale(v);
    case "rotation":
      return Math.round(v * 100) / 100;
    case "opacity":
      return clampOpacity(v);
    case "volume":
      return Math.round(clamp01(v) * 1e4) / 1e4;
  }
}
function sanitizeKeyframes(prop, raw) {
  if (!Array.isArray(raw)) return [];
  const byT = /* @__PURE__ */ new Map();
  for (const k of raw) {
    if (!k || typeof k !== "object") continue;
    const t = Number(k.t);
    const v = Number(k.v);
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    byT.set(Math.max(0, Math.round(t)), clampKfValue(prop, v));
  }
  return [...byT.entries()].sort((a2, b) => a2[0] - b[0]).map(([t, v]) => ({ t, v }));
}
function sampleKeyframes(kfs, tUs) {
  if (!kfs || kfs.length === 0) return null;
  let lo = null;
  let hi = null;
  for (const k of kfs) {
    if (!k || !Number.isFinite(k.t) || !Number.isFinite(k.v)) continue;
    if (k.t <= tUs) {
      if (!lo || k.t > lo.t) lo = k;
    }
    if (k.t >= tUs) {
      if (!hi || k.t < hi.t) hi = k;
    }
  }
  if (!lo && !hi) return null;
  if (!lo) return hi.v;
  if (!hi || hi.t === lo.t) return lo.v;
  const r = (tUs - lo.t) / (hi.t - lo.t);
  return lo.v + (hi.v - lo.v) * r;
}
function effectiveTransformAt(seg2, relUs) {
  const base = segTransform(seg2);
  const kf = seg2.keyframes;
  if (!kf) return base;
  let out = null;
  const ensure = () => out ??= { ...base };
  const x = sampleKeyframes(kf.x, relUs);
  if (x != null) ensure().x = clampPosRatio(x);
  const y = sampleKeyframes(kf.y, relUs);
  if (y != null) ensure().y = clampPosRatio(y);
  const sc = sampleKeyframes(kf.scale, relUs);
  if (sc != null) {
    const v = clampScale(sc);
    const ratio = base.scaleX !== 0 ? base.scaleY / base.scaleX : 1;
    const o = ensure();
    o.scaleX = v;
    o.scaleY = clampScale(v * ratio);
  }
  const rot = sampleKeyframes(kf.rotation, relUs);
  if (rot != null) ensure().rotation = rot;
  const op = sampleKeyframes(kf.opacity, relUs);
  if (op != null) ensure().opacity = clampOpacity(op);
  return out ?? base;
}
function effectiveVolumeAt(seg2, relUs) {
  const v = sampleKeyframes(seg2.keyframes?.volume, relUs);
  if (v != null) return clamp01(v);
  const base = seg2.volume;
  return base == null || !Number.isFinite(base) ? 1 : clamp01(base);
}
var JY_KF_PROPERTY = {
  x: "KFTypePositionX",
  y: "KFTypePositionY",
  scale: "KFTypeScaleX",
  rotation: "KFTypeRotation",
  opacity: "KFTypeAlpha",
  volume: "KFTypeVolume"
};
function jyKfValue(prop, v) {
  const c = clampKfValue(prop, v);
  if (prop === "x") return c * 2;
  if (prop === "y") return -c * 2;
  return c;
}
function toJyCommonKeyframes(seg2, kind, uuid) {
  const rec = seg2.keyframes;
  if (!rec) return [];
  const dur = Math.max(0, Math.round(seg2.targetDurationUs || 0));
  const props = kind === "audio" ? ["volume"] : RTC_KF_PROPS;
  const out = [];
  for (const prop of props) {
    const list = sanitizeKeyframes(prop, rec[prop]);
    if (list.length === 0) continue;
    const inRange = list.filter((k) => k.t >= 0 && k.t <= dur);
    const clamped = [...inRange];
    if (list.some((k) => k.t < 0) && !inRange.some((k) => k.t === 0)) {
      const v = sampleKeyframes(list, 0);
      if (v != null) clamped.unshift({ t: 0, v });
    }
    if (list.some((k) => k.t > dur) && !inRange.some((k) => k.t === dur)) {
      const v = sampleKeyframes(list, dur);
      if (v != null) clamped.push({ t: dur, v });
    }
    if (clamped.length === 0) continue;
    out.push({
      id: uuid(),
      keyframe_list: clamped.map((k) => ({
        curveType: "Line",
        graphID: "",
        left_control: { x: 0, y: 0 },
        right_control: { x: 0, y: 0 },
        id: uuid(),
        time_offset: Math.round(k.t),
        values: [jyKfValue(prop, k.v)]
      })),
      material_id: "",
      property_type: JY_KF_PROPERTY[prop]
    });
  }
  return out;
}

// src/lib/rtcOps.ts
var MIN_SEGMENT_US = 1e3;
function segEnd(s) {
  return s.targetStartUs + s.targetDurationUs;
}
function sortSegs(segs) {
  return [...segs].sort((a2, b) => a2.targetStartUs - b.targetStartUs);
}
function findSeg(doc2, segId) {
  for (const track2 of doc2.tracks) {
    const segIndex = track2.segments.findIndex((s) => s.id === segId);
    if (segIndex >= 0) return { track: track2, seg: track2.segments[segIndex], segIndex };
  }
  return null;
}
function replaceTrack(doc2, trackId, next) {
  return { ...doc2, tracks: doc2.tracks.map((t) => t.id === trackId ? next : t) };
}
function hasSourceWindow(seg2) {
  return (seg2.kind === "media" || seg2.kind === "compound") && seg2.sourceStartUs != null && seg2.sourceDurationUs != null;
}
function orderTracksForDisplay(tracks) {
  const text = tracks.filter((t) => t.type === "text");
  const video = tracks.filter((t) => t.type === "video");
  const audio = tracks.filter((t) => t.type === "audio");
  const [main, ...rest] = video;
  return [...text, ...rest.reverse(), ...main ? [main] : [], ...audio];
}
function trimSegment(doc2, segId, edge, deltaUs, opts) {
  const found = findSeg(doc2, segId);
  if (!found) return doc2;
  const { track: track2, seg: seg2, segIndex } = found;
  const speed = seg2.speed ?? 1;
  const withSource = hasSourceWindow(seg2);
  const prev = track2.segments[segIndex - 1];
  const next = track2.segments[segIndex + 1];
  let d2 = deltaUs;
  let patched;
  if (edge === "start") {
    d2 = Math.min(d2, seg2.targetDurationUs - MIN_SEGMENT_US);
    const floorUs = prev ? segEnd(prev) : 0;
    d2 = Math.max(d2, floorUs - seg2.targetStartUs);
    if (withSource) d2 = Math.max(d2, -seg2.sourceStartUs / speed);
    if (d2 === 0) return doc2;
    patched = {
      ...seg2,
      targetStartUs: seg2.targetStartUs + d2,
      targetDurationUs: seg2.targetDurationUs - d2,
      ...withSource ? {
        sourceStartUs: Math.round(seg2.sourceStartUs + d2 * speed),
        sourceDurationUs: Math.round(seg2.sourceDurationUs - d2 * speed)
      } : {}
    };
  } else {
    d2 = Math.max(d2, MIN_SEGMENT_US - seg2.targetDurationUs);
    if (next) d2 = Math.min(d2, next.targetStartUs - segEnd(seg2));
    if (withSource && opts?.sourceTotalUs != null) {
      const headroom = opts.sourceTotalUs - seg2.sourceStartUs - seg2.sourceDurationUs;
      d2 = Math.min(d2, headroom / speed);
    }
    if (d2 === 0) return doc2;
    patched = {
      ...seg2,
      targetDurationUs: seg2.targetDurationUs + d2,
      ...withSource ? { sourceDurationUs: Math.round(seg2.sourceDurationUs + d2 * speed) } : {}
    };
  }
  const segments = [...track2.segments];
  segments[segIndex] = patched;
  return replaceTrack(doc2, track2.id, { ...track2, segments: sortSegs(segments) });
}
function setSegmentSpeed(doc2, segId, speed) {
  const found = findSeg(doc2, segId);
  if (!found) return doc2;
  const { track: track2, seg: seg2, segIndex } = found;
  if (seg2.kind !== "media") return doc2;
  const cur = seg2.speed ?? 1;
  const v = Number.isFinite(speed) ? Math.min(5, Math.max(0.1, speed)) : cur;
  if (v === cur) return doc2;
  const next = track2.segments[segIndex + 1];
  const maxDur = next ? next.targetStartUs - seg2.targetStartUs : Infinity;
  const withSource = hasSourceWindow(seg2);
  const rawDur = withSource ? Math.round(seg2.sourceDurationUs / v) : Math.round(seg2.targetDurationUs * cur / v);
  const targetDurationUs = Math.max(MIN_SEGMENT_US, Math.min(rawDur, maxDur));
  const patched = {
    ...seg2,
    speed: v,
    targetDurationUs,
    // 钳位后回写 source 窗口时长维持不变量（未钳位时也回写——round 往返的 ±1µs 以不变量精确为准）
    ...withSource ? { sourceDurationUs: Math.round(targetDurationUs * v) } : {}
  };
  if (v === 1) delete patched.speed;
  const segments = [...track2.segments];
  segments[segIndex] = patched;
  return replaceTrack(doc2, track2.id, { ...track2, segments });
}
function splitSegment(doc2, segId, atUs) {
  const found = findSeg(doc2, segId);
  if (!found) return doc2;
  const { track: track2, seg: seg2, segIndex } = found;
  const start = seg2.targetStartUs;
  const end = segEnd(seg2);
  if (atUs - start < MIN_SEGMENT_US || end - atUs < MIN_SEGMENT_US) return doc2;
  const speed = seg2.speed ?? 1;
  const withSource = hasSourceWindow(seg2);
  const offsetUs = atUs - start;
  const srcOffsetUs = Math.round(offsetUs * speed);
  const left = {
    ...seg2,
    targetDurationUs: offsetUs,
    ...withSource ? { sourceDurationUs: srcOffsetUs } : {}
  };
  const right2 = {
    ...seg2,
    // assetId/uri/name 等原样共享——引用同一素材源头
    id: genId("seg"),
    targetStartUs: atUs,
    targetDurationUs: end - atUs,
    ...withSource ? {
      sourceStartUs: seg2.sourceStartUs + srcOffsetUs,
      sourceDurationUs: seg2.sourceDurationUs - srcOffsetUs
    } : {}
  };
  const segments = [...track2.segments];
  segments.splice(segIndex, 1, left, right2);
  return replaceTrack(doc2, track2.id, { ...track2, segments });
}
function removeSegments(doc2, ids) {
  const kill = new Set(ids);
  let changed = false;
  const tracks = doc2.tracks.map((t) => {
    const segments = t.segments.filter((s) => !kill.has(s.id));
    if (segments.length === t.segments.length) return t;
    changed = true;
    return { ...t, segments };
  });
  return changed ? { ...doc2, tracks } : doc2;
}

// src/lib/rtcCompound.ts
function segEnd2(s) {
  return s.targetStartUs + s.targetDurationUs;
}
function sortSegs2(segs) {
  return [...segs].sort((a2, b) => a2.targetStartUs - b.targetStartUs);
}
function subDocDurationUs(sub) {
  let max = 0;
  for (const t of sub.tracks) for (const s of t.segments) max = Math.max(max, segEnd2(s));
  return max;
}
function nextCompoundName(doc2) {
  return `\u590D\u5408\u7247\u6BB5${Object.keys(doc2.subDocs ?? {}).length + 1}`;
}
function createCompound(doc2, segIds, opts) {
  if (segIds.length === 0) return doc2;
  const wanted = new Set(segIds);
  const picked = /* @__PURE__ */ new Map();
  let found = 0;
  for (const t of doc2.tracks) {
    for (const s of t.segments) {
      if (!wanted.has(s.id)) continue;
      found++;
      if (s.kind !== "media") return doc2;
      const list = picked.get(t.id) ?? [];
      list.push(s);
      picked.set(t.id, list);
    }
  }
  if (found !== wanted.size) return doc2;
  let minStart = Infinity;
  let maxEnd = 0;
  for (const list of picked.values()) {
    for (const s of list) {
      minStart = Math.min(minStart, s.targetStartUs);
      maxEnd = Math.max(maxEnd, segEnd2(s));
    }
  }
  if (!(maxEnd > minStart)) return doc2;
  const spanUs = maxEnd - minStart;
  const subTracks = [];
  for (const t of doc2.tracks) {
    const list = picked.get(t.id);
    if (!list) continue;
    subTracks.push({
      id: genId("track"),
      type: t.type,
      ...t.name ? { name: t.name } : {},
      ...t.muted ? { muted: true } : {},
      segments: sortSegs2(list).map((s) => ({ ...s, targetStartUs: s.targetStartUs - minStart }))
    });
  }
  const subDocId = opts?.subDocId ?? genId("sub");
  const sub = { id: subDocId, name: opts?.name ?? nextCompoundName(doc2), tracks: subTracks };
  const hostId = orderTracksForDisplay(doc2.tracks).find((t) => picked.has(t.id))?.id;
  if (!hostId) return doc2;
  const compoundSeg = {
    id: opts?.segId ?? genId("seg"),
    kind: "compound",
    subDocId,
    name: sub.name,
    targetStartUs: minStart,
    targetDurationUs: spanUs,
    sourceStartUs: 0,
    sourceDurationUs: spanUs
  };
  const tracks = doc2.tracks.map((t) => {
    const segments = t.segments.filter((s) => !wanted.has(s.id));
    return segments.length === t.segments.length ? t : { ...t, segments };
  });
  let next = { ...doc2, tracks, subDocs: { ...doc2.subDocs, [subDocId]: sub } };
  const host = next.tracks.find((t) => t.id === hostId);
  const start = clampToNearestGap(host.segments, spanUs, minStart);
  next = {
    ...next,
    tracks: next.tracks.map(
      (t) => t.id === hostId ? { ...t, segments: sortSegs2([...t.segments, { ...compoundSeg, targetStartUs: start }]) } : t
    )
  };
  return next;
}
function clampToNearestGap(others, durUs, desiredUs) {
  const sorted = sortSegs2(others);
  const desired = Math.max(0, desiredUs);
  const gaps = [];
  let cursor = 0;
  for (const s of sorted) {
    if (s.targetStartUs - cursor >= durUs) gaps.push({ lo: cursor, hi: s.targetStartUs - durUs });
    cursor = Math.max(cursor, segEnd2(s));
  }
  gaps.push({ lo: cursor, hi: Infinity });
  let best = gaps[gaps.length - 1].lo;
  let bestCost = Infinity;
  for (const g of gaps) {
    const candidate = Math.min(Math.max(desired, g.lo), g.hi);
    const cost = Math.abs(candidate - desired);
    if (cost < bestCost) {
      bestCost = cost;
      best = candidate;
    }
  }
  return best;
}

// src/lib/rtcTextCore.ts
var DEFAULT_SUBTITLE_FONT_SIZE = 0.07;
var DEFAULT_SUBTITLE_COLOR = "#ffffff";
var DEFAULT_SUBTITLE_STROKE = "#000000";
var DEFAULT_SUBTITLE_Y = 0.4;
var SUBTITLE_FONT_MIN = 0.02;
var SUBTITLE_FONT_MAX = 0.2;
var clampNum = (v, lo, hi, d2) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d2;
  return Math.min(hi, Math.max(lo, n));
};
function normalizeHexColor(v, fallback) {
  if (typeof v === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim())) {
    return v.trim().toLowerCase();
  }
  return fallback;
}
function textStyleOf(seg2) {
  const t = seg2.text && typeof seg2.text === "object" ? seg2.text : {};
  return {
    content: typeof t.content === "string" ? t.content : "",
    fontSize: clampNum(t.fontSize, SUBTITLE_FONT_MIN, SUBTITLE_FONT_MAX, DEFAULT_SUBTITLE_FONT_SIZE),
    color: normalizeHexColor(t.color, DEFAULT_SUBTITLE_COLOR),
    strokeColor: normalizeHexColor(t.strokeColor, DEFAULT_SUBTITLE_STROKE),
    x: clampNum(t.x, -1, 1, 0),
    y: clampNum(t.y, -1, 1, DEFAULT_SUBTITLE_Y)
  };
}
function activeTextSegments(doc2, tUs) {
  const out = [];
  for (const track2 of doc2.tracks) {
    if (track2.type !== "text") continue;
    if (track2.role === "script") continue;
    for (const s of track2.segments) {
      if (s.kind !== "media") continue;
      if (!s.text?.content?.trim()) continue;
      if (tUs >= s.targetStartUs && tUs < s.targetStartUs + s.targetDurationUs) out.push(s);
    }
  }
  return out;
}
var JY_TEXT_SIZE_ANCHOR = 8 / DEFAULT_SUBTITLE_FONT_SIZE;
function jyTextSize(fontSizeRatio) {
  const fs = clampNum(fontSizeRatio, SUBTITLE_FONT_MIN, SUBTITLE_FONT_MAX, DEFAULT_SUBTITLE_FONT_SIZE);
  const v = Math.round(fs * JY_TEXT_SIZE_ANCHOR * 10) / 10;
  return Math.min(100, Math.max(1, v));
}
function hexToRgb01(hex, fallback = [1, 1, 1]) {
  const h = normalizeHexColor(hex, "");
  if (!h) return fallback;
  const raw = h.slice(1);
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  const to01 = (i) => Math.round(parseInt(full.slice(i, i + 2), 16) / 255 * 1e4) / 1e4;
  return [to01(0), to01(2), to01(4)];
}

// src/lib/jyTransitions.ts
var T = (name, resourceId, effectId, durMs, isOverlap, previewKind) => ({
  name,
  effectId,
  resourceId,
  defaultDurationUs: durMs * 1e3,
  isOverlap,
  ...previewKind ? { previewKind } : {}
});
var JY_TRANSITIONS = [
  T("\u53E0\u5316", "6724845717472416269", "322577", 500, true, "dissolve"),
  T("\u95EA\u9ED1", "6724239388189921806", "321493", 500, false, "flashblack"),
  T("\u95EA\u767D", "6724845376098013708", "322575", 500, false, "flashwhite"),
  T("\u8272\u5F69\u6EB6\u89E3", "6724846004274729480", "322583", 500, true),
  T("\u53E0\u52A0", "6914112332205396488", "1003369", 1e3, true),
  T("\u6A21\u7CCA", "6911569618171597320", "4212596", 500, true),
  T("\u96FE\u5316", "7216171159589491259", "11387229", 1200, true),
  T("\u63A8\u8FD1", "6724226861666144779", "359359", 1e3, false),
  T("\u62C9\u8FDC", "6724226338418332167", "359365", 1e3, false),
  T("\u5411\u5DE6", "6724227717195108867", "359529", 500, false),
  T("\u5411\u53F3", "6724227599616184836", "359527", 1e3, false),
  T("\u5DE6\u79FB", "6726711499676455435", "2917286", 1e3, true, "slideleft"),
  T("\u53F3\u79FB", "6726711296063967748", "2917287", 1e3, true, "slideright"),
  T("\u4E0A\u79FB", "6724846395116753416", "2917279", 500, true, "slideup"),
  T("\u4E0B\u79FB", "6724849276100284942", "2917280", 500, true, "slidedown"),
  T("\u5706\u5F62\u906E\u7F69", "6725767129519362573", "2916676", 500, true),
  T("\u9A6C\u8D5B\u514B", "6724866519022440967", "4212631", 1e3, true),
  T("\u9707\u52A8", "7198100561235808825", "9261771", 1e3, true)
];
var JY_PREVIEW_TRANSITIONS = JY_TRANSITIONS.filter((t) => t.previewKind);
function findJyTransition(effectId) {
  return JY_TRANSITIONS.find((t) => t.effectId === effectId);
}
function clampTransitionUs(us2, effectId) {
  const n = Number(us2);
  if (Number.isFinite(n) && n > 0) return Math.min(5e6, Math.max(1e5, Math.round(n)));
  return effectId && findJyTransition(effectId)?.defaultDurationUs || 5e5;
}

// src/rtc/rtcPlayback.ts
var US_PER_SEC = 1e6;
var TRANSITION_SLOT_SUFFIX = "#tr";
function transitionStateAt(segments, tUs) {
  for (const a2 of segments) {
    const tr = a2.transitionAfter;
    if (!tr) continue;
    const kind = findJyTransition(tr.effectId)?.previewKind;
    if (!kind) continue;
    const cut = a2.targetStartUs + a2.targetDurationUs;
    const b = segments.find((s) => s !== a2 && s.targetStartUs === cut);
    if (!b) continue;
    const d2 = Math.max(1, tr.durationUs);
    const isPush = kind.startsWith("slide");
    const start = isPush ? cut - d2 : cut - Math.floor(d2 / 2);
    const end = isPush ? cut : cut + Math.ceil(d2 / 2);
    if (tUs < Math.max(start, a2.targetStartUs) || tUs >= Math.min(end, b.targetStartUs + b.targetDurationUs)) continue;
    return { kind, p: Math.min(1, Math.max(0, (tUs - start) / (end - start))), side: tUs < cut ? "A" : "B", a: a2, b };
  }
  return null;
}
function slideDir(kind) {
  switch (kind) {
    case "slideleft":
      return { x: -1, y: 0 };
    case "slideright":
      return { x: 1, y: 0 };
    case "slideup":
      return { x: 0, y: -1 };
    case "slidedown":
      return { x: 0, y: 1 };
    default:
      return { x: 0, y: 0 };
  }
}
function transitionMainFx(ts) {
  if (ts.kind.startsWith("slide") && ts.side === "A") {
    const dir = slideDir(ts.kind);
    return { txPct: dir.x * ts.p * 100, tyPct: dir.y * ts.p * 100 };
  }
  return null;
}
function transitionGhost(ts) {
  if (ts.kind === "flashblack" || ts.kind === "flashwhite") {
    return { seg: null, freeze: "start", fx: { alphaMul: 1 - Math.abs(2 * ts.p - 1) }, fill: ts.kind === "flashblack" ? "#000" : "#fff" };
  }
  if (ts.kind === "dissolve") {
    return ts.side === "A" ? { seg: ts.b, freeze: "start", fx: { alphaMul: ts.p } } : { seg: ts.a, freeze: "end", fx: { alphaMul: 1 - ts.p } };
  }
  if (ts.side === "A") {
    const dir = slideDir(ts.kind);
    return { seg: ts.b, freeze: "start", fx: { txPct: -dir.x * (1 - ts.p) * 100, tyPct: -dir.y * (1 - ts.p) * 100 } };
  }
  return null;
}
function compoundSubTimeUs(seg2, tUs) {
  const speed = segmentRate(seg2);
  const s0 = seg2.sourceStartUs ?? 0;
  let subUs = s0 + Math.max(0, tUs - seg2.targetStartUs) * speed;
  if (seg2.sourceDurationUs != null) subUs = Math.min(subUs, s0 + seg2.sourceDurationUs);
  return subUs;
}
function subDocOf(doc2, seg2) {
  return seg2.kind === "compound" && seg2.subDocId && doc2.subDocs?.[seg2.subDocId] || null;
}
function subVideoTracksBottomUp(sub) {
  return orderTracksForDisplay(sub.tracks).filter((t) => t.type === "video").reverse();
}
function videoLayerTracksBottomUp(doc2) {
  return orderTracksForDisplay(doc2.tracks).filter((t) => t.type === "video").reverse();
}
function segmentAt(segments, tUs) {
  for (const s of segments) {
    if (tUs >= s.targetStartUs && tUs < s.targetStartUs + s.targetDurationUs) return s;
  }
  return null;
}
function videoStageAt(doc2, tUs) {
  const layers = [];
  let placeholder = null;
  let slotIndex = 0;
  for (const track2 of videoLayerTracksBottomUp(doc2)) {
    const ts = transitionStateAt(track2.segments, tUs);
    const seg2 = segmentAt(track2.segments, tUs);
    const activeCompound = seg2 && seg2.kind === "compound" ? seg2 : null;
    if (seg2 && !activeCompound) {
      if (seg2.kind === "placeholder") {
        placeholder = seg2;
      } else if (seg2.uri && (seg2.media === "image" || seg2.media === "video")) {
        const activeSide = ts && (ts.side === "A" && seg2 === ts.a || ts.side === "B" && seg2 === ts.b) ? ts : null;
        const mainFx = activeSide ? transitionMainFx(activeSide) : null;
        layers.push({
          trackId: track2.id,
          layerIndex: slotIndex,
          media: seg2.media,
          seg: seg2,
          uri: seg2.uri,
          sourceSec: sourceTimeSec(seg2, tUs),
          kfRelUs: tUs - seg2.targetStartUs,
          muted: seg2.media !== "video" || !!seg2.muted || !!track2.muted,
          volume: effectiveVolumeAt(seg2, tUs - seg2.targetStartUs),
          rate: segmentRate(seg2),
          ...mainFx ? { fx: mainFx } : {}
        });
      }
    }
    slotIndex++;
    if (ts) {
      const g = transitionGhost(ts);
      if (g) {
        if (g.fill) {
          layers.push({
            trackId: `${track2.id}${TRANSITION_SLOT_SUFFIX}`,
            layerIndex: slotIndex,
            media: "image",
            seg: ts.a,
            uri: "",
            sourceSec: 0,
            kfRelUs: 0,
            muted: true,
            volume: 0,
            rate: 1,
            fx: g.fx,
            ghost: true,
            fill: g.fill
          });
        } else if (g.seg && g.seg.kind === "media" && g.seg.uri && (g.seg.media === "image" || g.seg.media === "video")) {
          const freezeEnd = g.freeze === "end";
          layers.push({
            trackId: `${track2.id}${TRANSITION_SLOT_SUFFIX}`,
            layerIndex: slotIndex,
            media: g.seg.media,
            seg: g.seg,
            uri: g.seg.uri,
            sourceSec: freezeEnd ? sourceTimeSec(g.seg, g.seg.targetStartUs + g.seg.targetDurationUs) : (g.seg.sourceStartUs ?? 0) / US_PER_SEC,
            kfRelUs: freezeEnd ? g.seg.targetDurationUs : 0,
            muted: true,
            volume: 0,
            rate: 1,
            fx: g.fx,
            ghost: true,
            frozen: g.seg.media === "video"
          });
        }
      }
    }
    slotIndex++;
    for (const c of track2.segments) {
      const sub = subDocOf(doc2, c);
      if (!sub) continue;
      const cActive = activeCompound === c;
      const subT = cActive ? compoundSubTimeUs(c, tUs) : 0;
      const cRate = segmentRate(c);
      const cVolume = segmentVolume(c);
      const hostMuted = !!c.muted || !!track2.muted;
      for (const st of subVideoTracksBottomUp(sub)) {
        if (cActive) {
          const ss = segmentAt(st.segments, subT);
          if (ss && ss.kind === "media" && ss.uri && (ss.media === "image" || ss.media === "video")) {
            layers.push({
              trackId: `${c.id}/${st.id}`,
              layerIndex: slotIndex,
              media: ss.media,
              seg: ss,
              uri: ss.uri,
              sourceSec: sourceTimeSec(ss, subT),
              kfRelUs: subT - ss.targetStartUs,
              muted: ss.media !== "video" || !!ss.muted || !!st.muted || hostMuted,
              volume: clamp012(effectiveVolumeAt(ss, subT - ss.targetStartUs) * cVolume),
              rate: clampRate(segmentRate(ss) * cRate)
            });
          }
        }
        slotIndex++;
      }
    }
  }
  return { layers, placeholder: layers.length > 0 ? null : placeholder };
}
function clamp012(v) {
  return Math.min(1, Math.max(0, v));
}
function clampRate(v) {
  return Math.min(16, Math.max(0.1, v));
}
function sourceTimeSec(seg2, tUs) {
  const speed = segmentRate(seg2);
  const s0 = seg2.sourceStartUs ?? 0;
  let srcUs = s0 + Math.max(0, tUs - seg2.targetStartUs) * speed;
  if (seg2.sourceDurationUs != null) srcUs = Math.min(srcUs, s0 + seg2.sourceDurationUs);
  return srcUs / US_PER_SEC;
}
function segmentVolume(seg2) {
  const v = seg2.volume;
  if (v == null || !Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}
function segmentRate(seg2) {
  const v = seg2.speed;
  if (v == null || !Number.isFinite(v) || v <= 0) return 1;
  return Math.min(16, Math.max(0.1, v));
}

// src/lib/rtcCropCore.ts
var CROP_MIN_KEEP = 0.1;
var clamp013 = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
};
var round4 = (n) => {
  const r = Math.round(n * 1e4) / 1e4;
  return r === 0 ? 0 : r;
};
function normalizeCrop(c) {
  let left = clamp013(c.left);
  let right2 = clamp013(c.right);
  let top = clamp013(c.top);
  let bottom = clamp013(c.bottom);
  const maxSum = 1 - CROP_MIN_KEEP;
  if (left + right2 > maxSum) {
    const k = maxSum / (left + right2);
    left *= k;
    right2 *= k;
  }
  if (top + bottom > maxSum) {
    const k = maxSum / (top + bottom);
    top *= k;
    bottom *= k;
  }
  return { left: round4(left), top: round4(top), right: round4(right2), bottom: round4(bottom) };
}
function isEmptyCrop(c) {
  return c.left === 0 && c.top === 0 && c.right === 0 && c.bottom === 0;
}
function toJyCrop(crop) {
  if (!crop) return null;
  const n = normalizeCrop(crop);
  if (isEmptyCrop(n)) return null;
  return {
    upper_left_x: n.left,
    upper_left_y: n.top,
    upper_right_x: round4(1 - n.right),
    upper_right_y: n.top,
    lower_left_x: n.left,
    lower_left_y: round4(1 - n.bottom),
    lower_right_x: round4(1 - n.right),
    lower_right_y: round4(1 - n.bottom)
  };
}

// src/lib/jianyingCompound.ts
function pushCompanions(sink, speed) {
  const speedId = jyUuidHex();
  sink.speeds.push(
    speed !== 1 ? { curve_speed: null, id: speedId, mode: 0, speed, type: "speed" } : { id: speedId, type: "speed" }
  );
  const phId = jyUuidHex();
  sink.placeholder_infos.push({ id: phId, meta_type: "none", type: "placeholder_info" });
  const cvId = jyUuidHex();
  sink.canvases.push({ id: cvId, type: "canvas_color" });
  const scmId = jyUuidHex();
  sink.sound_channel_mappings.push({ id: scmId, type: "none" });
  const mcId = jyUuidHex();
  sink.material_colors.push({ id: mcId });
  const vsId = jyUuidHex();
  sink.vocal_separations.push({ id: vsId, type: "vocal_separation" });
  return { ids: [speedId, phId, cvId, scmId, mcId, vsId] };
}
function sampleSegmentJson(extraRefs, materialId, targetStart, targetDuration, sourceStart, sourceDuration) {
  return {
    responsive_layout: {},
    render_timerange: {},
    id: jyUuidHex(),
    enable_adjust_mask: false,
    enable_hsl: false,
    extra_material_refs: extraRefs,
    material_id: materialId,
    target_timerange: { start: targetStart, duration: targetDuration },
    source_timerange: { start: sourceStart, duration: sourceDuration },
    source: "segmentsourcenormal",
    hdr_settings: { mode: 1 },
    clip: { transform: { x: 0, y: 0 }, flip: {} }
  };
}
function basenameOf(absPath) {
  const parts = absPath.split(/[\\/]/);
  return parts[parts.length - 1] || absPath;
}
function lowerHyphenUuid() {
  return jyUuidUpper().toLowerCase();
}
function inlineVideoMaterialJson(id, r, durationUs) {
  return {
    audio_fade: null,
    category_id: "",
    category_name: "local",
    check_flag: 62978047,
    crop: {
      upper_left_x: 0,
      upper_left_y: 0,
      upper_right_x: 1,
      upper_right_y: 0,
      lower_left_x: 0,
      lower_left_y: 1,
      lower_right_x: 1,
      lower_right_y: 1
    },
    crop_ratio: "free",
    crop_scale: 1,
    duration: durationUs,
    extra_type_option: 0,
    height: r.height && r.height > 0 ? Math.round(r.height) : 1080,
    id,
    local_material_id: lowerHyphenUuid(),
    material_id: "",
    material_name: basenameOf(r.absPath),
    media_path: "",
    path: r.absPath,
    type: r.kind === "photo" ? "photo" : "video",
    width: r.width && r.width > 0 ? Math.round(r.width) : 1920
  };
}
function inlineAudioMaterialJson(id, r, durationUs) {
  return {
    app_id: 0,
    category_id: "",
    category_name: "local",
    check_flag: 3,
    copyright_limit_type: "none",
    duration: durationUs,
    effect_id: "",
    formula_id: "",
    id,
    local_material_id: id,
    music_id: id,
    name: basenameOf(r.absPath),
    path: r.absPath,
    source_platform: 0,
    type: "extract_music",
    wave_points: []
  };
}
function buildInlineDraft(sub, uuid, opts) {
  const speeds = [];
  const placeholderInfos = [];
  const canvases = [];
  const soundChannelMappings = [];
  const materialColors = [];
  const vocalSeparations = [];
  const videos = [];
  const audios = [];
  const sink = {
    speeds,
    placeholder_infos: placeholderInfos,
    hsl: [],
    // 内联片段不带 hsl（§2.3：hsl 仅主草稿复合段引用）
    canvases,
    sound_channel_mappings: soundChannelMappings,
    material_colors: materialColors,
    vocal_separations: vocalSeparations
  };
  const matByAsset = /* @__PURE__ */ new Map();
  let durationUs = 0;
  let transformWarned = false;
  const tracks = [];
  for (const t of sub.tracks) {
    if (t.type === "text") {
      if (t.segments.length > 0) opts.warnings.push(`\u590D\u5408\u7247\u6BB5\u300C${sub.name}\u300D\u5185\u7684\u6587\u672C\u8F68\u6682\u4E0D\u652F\u6301\u5BFC\u51FA\uFF0C\u5DF2\u8DF3\u8FC7 ${t.segments.length} \u6BB5`);
      continue;
    }
    const segJsons = [];
    const ordered = [...t.segments].sort((a2, b) => (a2.targetStartUs || 0) - (b.targetStartUs || 0));
    for (const seg2 of ordered) {
      if (seg2.kind !== "media") {
        opts.warnings.push(`\u590D\u5408\u7247\u6BB5\u300C${sub.name}\u300D\u5185\u7684\u5360\u4F4D\u7247\u6BB5\u300C${seg2.name || seg2.id}\u300D\u5C1A\u672A\u751F\u6210\uFF0C\u5DF2\u8DF3\u8FC7`);
        continue;
      }
      if (!seg2.assetId || !(seg2.targetDurationUs > 0)) {
        opts.warnings.push(`\u590D\u5408\u7247\u6BB5\u300C${sub.name}\u300D\u5185\u7684\u7247\u6BB5\u300C${seg2.name || seg2.id}\u300D\u7F3A\u5C11\u7D20\u6750\u5F15\u7528\u6216\u65F6\u957F\u4E3A 0\uFF0C\u5DF2\u8DF3\u8FC7`);
        continue;
      }
      let entry = matByAsset.get(seg2.assetId);
      if (!entry) {
        const r = opts.resolve(seg2.assetId);
        if (!r || !r.absPath) {
          opts.warnings.push(`\u590D\u5408\u7247\u6BB5\u300C${sub.name}\u300D\u5185\u7D20\u6750 ${seg2.assetId} \u672C\u5730\u6587\u4EF6\u7F3A\u5931\uFF0C\u5DF2\u8DF3\u8FC7`);
          continue;
        }
        entry = { id: jyUuidHex(), kind: r.kind };
        matByAsset.set(seg2.assetId, entry);
        opts.onAssetUsed(seg2.assetId, r);
        const dur = r.kind === "photo" ? JY_PHOTO_DURATION_US : Math.max(0, Math.round(r.durationUs));
        if (r.kind === "audio") audios.push(inlineAudioMaterialJson(entry.id, r, dur));
        else videos.push(inlineVideoMaterialJson(entry.id, r, dur));
      }
      const speed = seg2.speed && seg2.speed > 0 ? seg2.speed : 1;
      const hasSource = seg2.sourceDurationUs != null && seg2.sourceDurationUs > 0;
      const targetStart = Math.max(0, Math.round(seg2.targetStartUs));
      const targetDuration = Math.max(0, Math.round(seg2.targetDurationUs));
      const sourceStart = hasSource ? Math.max(0, Math.round(seg2.sourceStartUs)) : 0;
      const sourceDuration = hasSource ? Math.max(0, Math.round(seg2.sourceDurationUs)) : Math.round(targetDuration * speed);
      const refs = pushCompanions(sink, speed);
      const json2 = sampleSegmentJson(refs.ids, entry.id, targetStart, targetDuration, sourceStart, sourceDuration);
      if (seg2.muted) json2.volume = 0;
      else if (seg2.volume != null && seg2.volume >= 0 && seg2.volume !== 1) json2.volume = seg2.volume;
      if (seg2.transform && !transformWarned) {
        transformWarned = true;
        opts.warnings.push(`\u590D\u5408\u7247\u6BB5\u300C${sub.name}\u300D\u5185\u7247\u6BB5\u7684\u753B\u9762\u53D8\u6362\u6682\u4E0D\u968F\u526A\u6620\u5BFC\u51FA\uFF08P0\uFF09\uFF0C\u5DF2\u6309\u9ED8\u8BA4\u753B\u9762\u5BFC\u51FA`);
      }
      segJsons.push(json2);
      durationUs = Math.max(durationUs, targetStart + targetDuration);
    }
    if (segJsons.length === 0) continue;
    tracks.push({ id: jyUuidHex(), is_default_name: !t.name, segments: segJsons, type: t.type });
  }
  const json = {
    canvas_config: { height: opts.canvasHeight, width: opts.canvasWidth },
    color_space: 0,
    config: { maintrack_adsorb: true },
    duration: durationUs,
    function_assistant_info: null,
    id: uuid,
    keyframes: {
      adjusts: [],
      audios: [],
      effects: [],
      filters: [],
      handwrites: [],
      stickers: [],
      texts: [],
      videos: []
    },
    last_modified_platform: { app_id: 3704, app_source: "lv", app_version: "10.9.0", os: "windows" },
    materials: {
      audios,
      canvases,
      material_colors: materialColors,
      placeholder_infos: placeholderInfos,
      sound_channel_mappings: soundChannelMappings,
      speeds,
      videos,
      vocal_separations: vocalSeparations
    },
    name: sub.name || "\u590D\u5408\u7247\u6BB5",
    new_version: "110.0.0",
    path: "",
    platform: { app_id: 3704, app_source: "lv", app_version: "10.9.0", os: "windows" },
    render_index_track_mode_on: false,
    smart_ads_info: null,
    tracks,
    uneven_animation_template_info: null,
    version: 36e4
  };
  return { json, durationUs };
}
function virtualVideoMaterialJson(id, name, durationUs, w, h) {
  return {
    path: "",
    extra_type_option: 2,
    duration: durationUs,
    is_set_beauty_mode: true,
    crop: {},
    video_mask_shadow: { resource_id: "", path: "" },
    check_flag: 62978047,
    video_mask_stroke: { path: "", type: "", resource_id: "" },
    material_name: name,
    id,
    width: w,
    video_algorithm: { story_video_modify_video_config: {}, path: "" },
    material_id: "",
    matting: { path: "" },
    beauty_face_auto_preset: {},
    height: h,
    type: "video",
    stable: { time_range: {} },
    is_copyright: true
  };
}
function draftsMaterialJson(uuid, inline2, name, pathPrefix, rich) {
  const base = {
    id: jyUuidUpper(),
    type: "combination",
    combination_type: "none",
    combination_id: uuid,
    draft_cover_path: `${pathPrefix}draft_cover.jpg`,
    draft_config_path: `${pathPrefix}sub_draft_config.json`,
    draft_file_path: `${pathPrefix}draft_content.json`,
    draft: inline2
  };
  if (rich) {
    base.aimusic_mv_template_info = null;
    base.category_id = "";
    base.category_name = "";
    base.formula_id = "";
    base.name = name;
    base.precompile_combination = false;
  }
  return base;
}
function buildWrapper(sub, uuid, inline2, subDurationUs, opts) {
  const wrapper = contentTemplate();
  wrapper.id = uuid;
  wrapper.fps = opts.fps;
  wrapper.duration = subDurationUs;
  wrapper.canvas_config = { height: opts.canvasHeight, ratio: "original", width: opts.canvasWidth };
  wrapper.name = sub.name || "\u590D\u5408\u7247\u6BB5";
  const sep = opts.draftFolderPath ? opts.draftFolderPath.includes("\\") ? "\\" : "/" : "/";
  const absPrefix = opts.draftFolderPath ? `${opts.draftFolderPath}${sep}subdraft${sep}${uuid}${sep}` : `subdraft/${uuid}/`;
  const materials = wrapper.materials;
  const virtualId = jyUuidUpper();
  materials.videos = [
    virtualVideoMaterialJson(virtualId, sub.name || "\u590D\u5408\u7247\u6BB5", subDurationUs, opts.canvasWidth, opts.canvasHeight)
  ];
  const drafts = draftsMaterialJson(uuid, inline2, sub.name || "\u590D\u5408\u7247\u6BB5", absPrefix, true);
  materials.drafts = [drafts];
  materials.placeholder_infos = [];
  const sink = {
    speeds: materials.speeds,
    placeholder_infos: materials.placeholder_infos,
    hsl: materials.hsl,
    canvases: materials.canvases,
    sound_channel_mappings: materials.sound_channel_mappings,
    material_colors: materials.material_colors,
    vocal_separations: materials.vocal_separations
  };
  const refs = pushCompanions(sink, 1);
  const hslId = jyUuidHex();
  materials.hsl.push({ id: hslId, type: "hsl" });
  const extraRefs = [drafts.id, refs.ids[0], refs.ids[1], hslId, refs.ids[2], refs.ids[3], refs.ids[4], refs.ids[5]];
  const segJson = sampleSegmentJson(extraRefs, virtualId, 0, subDurationUs, 0, subDurationUs);
  wrapper.tracks = [
    { attribute: 0, flag: 0, id: jyUuidHex(), is_default_name: true, name: "", segments: [segJson], type: "video" }
  ];
  return wrapper;
}
function buildSubDraftConfig(sub, uuid, subDurationUs, nowMs) {
  return {
    audio_path: "",
    cover_height: 180,
    cover_path: "draft_cover.jpg",
    cover_width: 320,
    create_time: Math.floor(nowMs / 1e3),
    draft_json_file: "draft_content.json",
    id: uuid,
    import_time_ms: nowMs,
    is_from_multi_timeline: false,
    is_from_sub_draft: true,
    material_color_tag: "",
    name: sub.name || "\u590D\u5408\u7247\u6BB5",
    project_id: uuid,
    rough_cut_duration: subDurationUs,
    rough_cut_start: 0,
    source: "timeline",
    type: "video"
  };
}
function buildCompoundShared(sub, opts) {
  const uuid = jyUuidUpper();
  const { json: inline2 } = buildInlineDraft(sub, uuid, opts);
  const subDurationUs = Math.max(Number(inline2.duration) || 0, subDocDurationUs(sub));
  const virtualMaterial = virtualVideoMaterialJson(
    jyUuidUpper(),
    sub.name || "\u590D\u5408\u7247\u6BB5",
    subDurationUs,
    opts.canvasWidth,
    opts.canvasHeight
  );
  const draftsMaterial = draftsMaterialJson(uuid, inline2, sub.name || "\u590D\u5408\u7247\u6BB5", `subdraft/${uuid}/`, false);
  const wrapperJson = buildWrapper(sub, uuid, inline2, subDurationUs, opts);
  const configJson = buildSubDraftConfig(sub, uuid, subDurationUs, opts.nowMs);
  return {
    subdraftUuid: uuid,
    virtualMaterial,
    draftsMaterial,
    subDurationUs,
    subdraft: { uuid, wrapperJson, configJson }
  };
}
function buildCompoundSegmentJson(seg2, shared, sink) {
  const speed = seg2.speed && seg2.speed > 0 ? seg2.speed : 1;
  const targetStart = Math.max(0, Math.round(seg2.targetStartUs));
  const targetDuration = Math.max(0, Math.round(seg2.targetDurationUs));
  const hasSource = seg2.sourceDurationUs != null && seg2.sourceDurationUs > 0;
  const sourceStart = hasSource ? Math.max(0, Math.round(seg2.sourceStartUs)) : 0;
  const sourceDuration = hasSource ? Math.max(0, Math.round(seg2.sourceDurationUs)) : shared.subDurationUs;
  const refs = pushCompanions(sink, speed);
  const hslId = jyUuidHex();
  sink.hsl.push({ id: hslId, type: "hsl" });
  const extraRefs = [
    shared.draftsMaterial.id,
    refs.ids[0],
    // speeds
    refs.ids[1],
    // placeholder_infos
    hslId,
    refs.ids[2],
    // canvases
    refs.ids[3],
    // sound_channel_mappings
    refs.ids[4],
    // material_colors
    refs.ids[5]
    // vocal_separations
  ];
  return sampleSegmentJson(
    extraRefs,
    shared.virtualMaterial.id,
    targetStart,
    targetDuration,
    sourceStart,
    sourceDuration
  );
}

// src/lib/jianyingDraft.ts
var JY_PHOTO_DURATION_US = 108e8;
function jyUuidHex() {
  const b = randomBytes16();
  b[6] = b[6] & 15 | 64;
  b[8] = b[8] & 63 | 128;
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function jyUuidUpper() {
  const h = jyUuidHex().toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function randomBytes16() {
  const b = new Uint8Array(16);
  const c = globalThis.crypto;
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}
function us(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
}
function basenameOf2(absPath) {
  const parts = absPath.split(/[\\/]/);
  return parts[parts.length - 1] || absPath;
}
function contentTemplate() {
  return {
    canvas_config: { height: 1080, ratio: "original", width: 1920 },
    color_space: 0,
    config: {
      adjust_max_index: 1,
      attachment_info: [],
      combination_max_index: 1,
      export_range: null,
      extract_audio_last_index: 1,
      lyrics_recognition_id: "",
      lyrics_sync: true,
      lyrics_taskinfo: [],
      maintrack_adsorb: true,
      material_save_mode: 0,
      multi_language_current: "none",
      multi_language_list: [],
      multi_language_main: "none",
      multi_language_mode: "none",
      original_sound_last_index: 1,
      record_audio_last_index: 1,
      sticker_max_index: 1,
      subtitle_keywords_config: null,
      subtitle_recognition_id: "",
      subtitle_sync: true,
      subtitle_taskinfo: [],
      system_font_list: [],
      video_mute: false,
      zoom_info_params: null
    },
    cover: null,
    create_time: 0,
    duration: 0,
    extra_info: null,
    fps: 30,
    free_render_index_mode_on: false,
    group_container: null,
    id: jyUuidUpper(),
    keyframe_graph_list: [],
    keyframes: {
      adjusts: [],
      audios: [],
      effects: [],
      filters: [],
      handwrites: [],
      stickers: [],
      texts: [],
      videos: []
    },
    last_modified_platform: { app_id: 3704, app_source: "lv", app_version: "5.9.0", os: "windows" },
    platform: { app_id: 3704, app_source: "lv", app_version: "5.9.0", os: "windows" },
    materials: emptyMaterials(),
    mutable_config: null,
    name: "",
    new_version: "110.0.0",
    relationships: [],
    render_index_track_mode_on: false,
    retouch_cover: null,
    source: "default",
    static_cover_image_path: "",
    time_marks: null,
    tracks: [],
    update_time: 0,
    version: 36e4
  };
}
function emptyMaterials() {
  return {
    ai_translates: [],
    audio_balances: [],
    audio_effects: [],
    audio_fades: [],
    audio_track_indexes: [],
    audios: [],
    beats: [],
    canvases: [],
    chromas: [],
    color_curves: [],
    digital_humans: [],
    drafts: [],
    effects: [],
    flowers: [],
    green_screens: [],
    handwrites: [],
    hsl: [],
    images: [],
    log_color_wheels: [],
    loudnesses: [],
    manual_deformations: [],
    masks: [],
    material_animations: [],
    material_colors: [],
    multi_language_refs: [],
    placeholders: [],
    plugin_effects: [],
    primary_color_wheels: [],
    realtime_denoises: [],
    shapes: [],
    smart_crops: [],
    smart_relights: [],
    sound_channel_mappings: [],
    speeds: [],
    stickers: [],
    tail_leaders: [],
    text_templates: [],
    texts: [],
    time_marks: [],
    transitions: [],
    video_effects: [],
    video_trackings: [],
    videos: [],
    vocal_beautifys: [],
    vocal_separations: []
  };
}
function metaTemplate() {
  return {
    cloud_package_completed_time: "",
    draft_cloud_capcut_purchase_info: "",
    draft_cloud_last_action_download: false,
    draft_cloud_materials: [],
    draft_cloud_purchase_info: "",
    draft_cloud_template_id: "",
    draft_cloud_tutorial_info: "",
    draft_cloud_videocut_purchase_info: "",
    draft_cover: "",
    draft_deeplink_url: "",
    draft_enterprise_info: {
      draft_enterprise_extra: "",
      draft_enterprise_id: "",
      draft_enterprise_name: "",
      enterprise_material: []
    },
    draft_fold_path: "",
    draft_id: jyUuidUpper(),
    draft_is_ai_packaging_used: false,
    draft_is_ai_shorts: false,
    draft_is_ai_translate: false,
    draft_is_article_video_draft: false,
    draft_is_from_deeplink: "false",
    draft_is_invisible: false,
    draft_materials: [0, 1, 2, 3, 6, 7, 8].map((t) => ({ type: t, value: [] })),
    draft_materials_copied_info: [],
    draft_name: "",
    draft_new_version: "",
    draft_removable_storage_device: "",
    draft_root_path: "",
    draft_segment_extra_info: [],
    draft_type: "",
    tm_draft_cloud_completed: "",
    tm_draft_cloud_modified: 0,
    tm_draft_removed: 0,
    tm_duration: 0
  };
}
function videoMaterialJson(id, r, durationUs, crop) {
  return {
    audio_fade: null,
    category_id: "",
    category_name: "local",
    check_flag: 63487,
    crop: crop ?? {
      upper_left_x: 0,
      upper_left_y: 0,
      upper_right_x: 1,
      upper_right_y: 0,
      lower_left_x: 0,
      lower_left_y: 1,
      lower_right_x: 1,
      lower_right_y: 1
    },
    crop_ratio: "free",
    crop_scale: 1,
    duration: durationUs,
    height: r.height && r.height > 0 ? Math.round(r.height) : 1080,
    id,
    local_material_id: "",
    material_id: id,
    material_name: basenameOf2(r.absPath),
    media_path: "",
    path: r.absPath,
    type: r.kind === "photo" ? "photo" : "video",
    width: r.width && r.width > 0 ? Math.round(r.width) : 1920
  };
}
function audioMaterialJson(id, r, durationUs) {
  return {
    app_id: 0,
    category_id: "",
    category_name: "local",
    check_flag: 3,
    copyright_limit_type: "none",
    duration: durationUs,
    effect_id: "",
    formula_id: "",
    id,
    local_material_id: id,
    music_id: id,
    name: basenameOf2(r.absPath),
    path: r.absPath,
    source_platform: 0,
    type: "extract_music",
    wave_points: []
  };
}
function buildSegmentJson(seg2, materialId, kind, speeds) {
  const speed = seg2.speed && seg2.speed > 0 ? seg2.speed : 1;
  const volume = seg2.muted ? 0 : seg2.volume != null && seg2.volume >= 0 ? seg2.volume : 1;
  const targetStart = us(seg2.targetStartUs);
  const targetDuration = us(seg2.targetDurationUs);
  const hasSource = seg2.sourceDurationUs != null && seg2.sourceDurationUs > 0;
  const sourceStart = hasSource ? us(seg2.sourceStartUs) : 0;
  const sourceDuration = hasSource ? us(seg2.sourceDurationUs) : Math.round(targetDuration * speed);
  const speedId = jyUuidHex();
  speeds.push({ curve_speed: null, id: speedId, mode: 0, speed, type: "speed" });
  const json = {
    enable_adjust: true,
    enable_color_correct_adjust: false,
    enable_color_curves: true,
    enable_color_match_adjust: false,
    enable_color_wheels: true,
    enable_lut: true,
    enable_smart_color_adjust: false,
    last_nonzero_volume: volume > 0 ? volume : 1,
    reverse: false,
    track_attribute: 0,
    track_render_index: 0,
    visible: true,
    id: jyUuidHex(),
    material_id: materialId,
    target_timerange: { start: targetStart, duration: targetDuration },
    // ── 第二批：关键帧——无关键帧片段恒为 []（与改造前逐字节一致，存量草稿零变化）；
    // 音频片段只导 volume（KFTypeVolume），视觉片段六属性全导，越界帧钳制见 toJyCommonKeyframes
    common_keyframes: toJyCommonKeyframes(seg2, kind, jyUuidHex),
    keyframe_refs: [],
    source_timerange: { start: sourceStart, duration: sourceDuration },
    speed,
    volume,
    extra_material_refs: [speedId],
    is_tone_modify: false
  };
  if (kind === "audio") {
    json.clip = null;
    json.hdr_settings = null;
  } else {
    const t = segTransform(seg2);
    json.clip = toJyClip(t);
    json.uniform_scale = { on: jyUniformScaleOn(t), value: 1 };
    json.hdr_settings = { intensity: 1, mode: 1, nits: 1e3 };
  }
  return { json, endUs: targetStart + targetDuration };
}
function segLabel(track2, seg2, index) {
  return seg2.name || `${track2.name || track2.type} \u8F68\u7B2C ${index + 1} \u6BB5`;
}
function buildDraftContent(doc2, resolve2, opts) {
  const warnings = [];
  const speeds = [];
  const videoMaterials = [];
  const audioMaterials = [];
  const textMaterials = [];
  const transitionMaterials = [];
  const materialByAsset = /* @__PURE__ */ new Map();
  const resolvedByAsset = /* @__PURE__ */ new Map();
  const usedAssetIds = [];
  const maxSourceEnd = /* @__PURE__ */ new Map();
  const cropClones = [];
  const textTrackJsons = [];
  const ensureResolved = (assetId, label) => {
    const cached = resolvedByAsset.get(assetId);
    if (cached) return cached;
    const r = resolve2(assetId);
    if (!r || !r.absPath) {
      warnings.push(`\u7D20\u6750 ${assetId}\uFF08\u7247\u6BB5\u300C${label}\u300D\uFF09\u672C\u5730\u6587\u4EF6\u7F3A\u5931\uFF0C\u5DF2\u8DF3\u8FC7`);
      return null;
    }
    resolvedByAsset.set(assetId, r);
    usedAssetIds.push(assetId);
    return r;
  };
  const nowMs = opts?.nowMs ?? Date.now();
  const canvasW = opts?.canvasWidth && opts.canvasWidth > 0 ? Math.round(opts.canvasWidth) : 1920;
  const canvasH = opts?.canvasHeight && opts.canvasHeight > 0 ? Math.round(opts.canvasHeight) : 1080;
  const subdrafts = [];
  const compoundSharedBySub = /* @__PURE__ */ new Map();
  const draftsMaterials = [];
  const compSink = {
    speeds,
    placeholder_infos: [],
    hsl: [],
    canvases: [],
    sound_channel_mappings: [],
    material_colors: [],
    vocal_separations: []
  };
  const subKindByAsset = /* @__PURE__ */ new Map();
  const noteSubAsset = (assetId, r) => {
    if (!resolvedByAsset.has(assetId)) {
      resolvedByAsset.set(assetId, r);
      usedAssetIds.push(assetId);
    }
    if (!subKindByAsset.has(assetId)) subKindByAsset.set(assetId, r.kind);
  };
  const tracks = [];
  let docDurationUs = 0;
  for (const track2 of doc2.tracks) {
    if (track2.role === "script") continue;
    if (track2.type === "text") {
      const segJsons2 = [];
      const ordered2 = [...track2.segments].sort((a2, b) => (a2.targetStartUs || 0) - (b.targetStartUs || 0));
      for (let i = 0; i < ordered2.length; i++) {
        const seg2 = ordered2[i];
        if (seg2.kind !== "media" || !seg2.text?.content?.trim()) {
          warnings.push(`\u6587\u672C\u8F68\u300C${track2.name || "\u5B57\u5E55"}\u300D\u7B2C ${i + 1} \u6BB5\uFF08${segLabel(track2, seg2, i)}\uFF09\u65E0\u5B57\u5E55\u5185\u5BB9\uFF0C\u5DF2\u8DF3\u8FC7`);
          continue;
        }
        if (!(us(seg2.targetDurationUs) > 0)) {
          warnings.push(`\u6587\u672C\u8F68\u7247\u6BB5\u300C${segLabel(track2, seg2, i)}\u300D\u65F6\u957F\u4E3A 0\uFF0C\u5DF2\u8DF3\u8FC7`);
          continue;
        }
        const style = textStyleOf(seg2);
        const matId = jyUuidHex();
        textMaterials.push(textMaterialJson(matId, style));
        const built = buildTextSegmentJson(seg2, matId, style, speeds);
        segJsons2.push(built.json);
        docDurationUs = Math.max(docDurationUs, built.endUs);
      }
      if (segJsons2.length === 0) continue;
      textTrackJsons.push({
        attribute: track2.muted ? 1 : 0,
        flag: 0,
        id: jyUuidHex(),
        is_default_name: !track2.name,
        name: track2.name || "",
        segments: segJsons2,
        type: "text"
      });
      continue;
    }
    const segJsons = [];
    const ordered = [...track2.segments].sort((a2, b) => (a2.targetStartUs || 0) - (b.targetStartUs || 0));
    for (let i = 0; i < ordered.length; i++) {
      const seg2 = ordered[i];
      if (seg2.kind === "placeholder") {
        warnings.push(`\u5360\u4F4D\u7B26\u7247\u6BB5\u300C${segLabel(track2, seg2, i)}\u300D\u5C1A\u672A\u751F\u6210\u89C6\u9891\uFF0C\u5DF2\u8DF3\u8FC7`);
        continue;
      }
      if (seg2.kind === "compound") {
        const sub = seg2.subDocId ? doc2.subDocs?.[seg2.subDocId] : void 0;
        if (!sub) {
          warnings.push(`\u590D\u5408\u7247\u6BB5\u300C${segLabel(track2, seg2, i)}\u300D\u7F3A\u5C11\u5B50\u65F6\u95F4\u8F74\u6570\u636E\uFF0C\u5DF2\u8DF3\u8FC7`);
          continue;
        }
        if (!(us(seg2.targetDurationUs) > 0)) {
          warnings.push(`\u590D\u5408\u7247\u6BB5\u300C${segLabel(track2, seg2, i)}\u300D\u65F6\u957F\u4E3A 0\uFF0C\u5DF2\u8DF3\u8FC7`);
          continue;
        }
        let shared = compoundSharedBySub.get(seg2.subDocId);
        if (!shared) {
          shared = buildCompoundShared(sub, {
            resolve: resolve2,
            fps: doc2.fps && doc2.fps > 0 ? doc2.fps : 30,
            canvasWidth: canvasW,
            canvasHeight: canvasH,
            nowMs,
            draftFolderPath: opts?.draftFolderPath,
            warnings,
            onAssetUsed: noteSubAsset
          });
          compoundSharedBySub.set(seg2.subDocId, shared);
          videoMaterials.push(shared.virtualMaterial);
          draftsMaterials.push(shared.draftsMaterial);
          subdrafts.push(shared.subdraft);
        }
        segJsons.push(buildCompoundSegmentJson(seg2, shared, compSink));
        docDurationUs = Math.max(docDurationUs, us(seg2.targetStartUs) + us(seg2.targetDurationUs));
        continue;
      }
      if (!seg2.assetId) {
        warnings.push(`\u7247\u6BB5\u300C${segLabel(track2, seg2, i)}\u300D\u7F3A\u5C11\u7D20\u6750\u5F15\u7528\uFF08assetId\uFF09\uFF0C\u5DF2\u8DF3\u8FC7`);
        continue;
      }
      if (!(us(seg2.targetDurationUs) > 0)) {
        warnings.push(`\u7247\u6BB5\u300C${segLabel(track2, seg2, i)}\u300D\u65F6\u957F\u4E3A 0\uFF0C\u5DF2\u8DF3\u8FC7`);
        continue;
      }
      const r = ensureResolved(seg2.assetId, segLabel(track2, seg2, i));
      if (!r) continue;
      const cropJson = r.kind !== "audio" ? toJyCrop(seg2.crop) : null;
      let materialId;
      let kind;
      if (cropJson) {
        materialId = jyUuidHex();
        kind = r.kind;
        const dur = r.kind === "photo" ? us(r.durationUs) || JY_PHOTO_DURATION_US : us(r.durationUs);
        const mat = videoMaterialJson(materialId, r, dur, cropJson);
        videoMaterials.push(mat);
        cropClones.push({ assetId: seg2.assetId, mat });
      } else {
        let entry = materialByAsset.get(seg2.assetId);
        if (!entry) {
          entry = { materialId: jyUuidHex(), kind: r.kind };
          materialByAsset.set(seg2.assetId, entry);
          if (r.kind === "audio") audioMaterials.push(audioMaterialJson(entry.materialId, r, us(r.durationUs)));
          else videoMaterialJson0(videoMaterials, entry.materialId, r);
        }
        materialId = entry.materialId;
        kind = entry.kind;
      }
      const built = buildSegmentJson(seg2, materialId, kind, speeds);
      const srcEnd = built.json.source_timerange;
      maxSourceEnd.set(seg2.assetId, Math.max(maxSourceEnd.get(seg2.assetId) ?? 0, srcEnd.start + srcEnd.duration));
      if (track2.type === "video" && seg2.transitionAfter) {
        const trId = jyUuidHex();
        transitionMaterials.push(transitionMaterialJson(trId, seg2.transitionAfter));
        built.json.extra_material_refs.push(trId);
      }
      segJsons.push(built.json);
      docDurationUs = Math.max(docDurationUs, built.endUs);
    }
    if (segJsons.length === 0) continue;
    tracks.push({
      attribute: track2.muted ? 1 : 0,
      flag: 0,
      id: jyUuidHex(),
      is_default_name: !track2.name,
      name: track2.name || "",
      segments: segJsons,
      type: track2.type
    });
  }
  tracks.push(...textTrackJsons);
  tracks.forEach((t, ti) => {
    for (const s of t.segments) {
      if (s.source === "segmentsourcenormal") continue;
      s.render_index = ti;
    }
  });
  for (const [assetId, entry] of materialByAsset) {
    const list = entry.kind === "audio" ? audioMaterials : videoMaterials;
    const mat = list.find((m) => m.id === entry.materialId);
    if (!mat) continue;
    const need = maxSourceEnd.get(assetId) ?? 0;
    const cur = Number(mat.duration) || 0;
    if (entry.kind === "photo") mat.duration = Math.max(cur > 0 ? cur : JY_PHOTO_DURATION_US, need);
    else mat.duration = Math.max(cur, need);
  }
  for (const { assetId, mat } of cropClones) {
    mat.duration = Math.max(Number(mat.duration) || 0, maxSourceEnd.get(assetId) ?? 0);
  }
  const draftContent = contentTemplate();
  draftContent.fps = doc2.fps && doc2.fps > 0 ? doc2.fps : 30;
  draftContent.duration = docDurationUs;
  draftContent.canvas_config = { height: canvasH, ratio: "original", width: canvasW };
  const materials = draftContent.materials;
  materials.videos = videoMaterials;
  materials.audios = audioMaterials;
  materials.speeds = speeds;
  materials.texts = textMaterials;
  materials.transitions = transitionMaterials;
  if (compoundSharedBySub.size > 0) {
    materials.drafts = draftsMaterials;
    materials.placeholder_infos = compSink.placeholder_infos;
    materials.hsl = compSink.hsl;
    materials.canvases = compSink.canvases;
    materials.sound_channel_mappings = compSink.sound_channel_mappings;
    materials.material_colors = compSink.material_colors;
    materials.vocal_separations = compSink.vocal_separations;
  }
  draftContent.tracks = tracks;
  const draftMetaInfo = metaTemplate();
  draftMetaInfo.draft_name = opts?.draftName || doc2.name || "";
  draftMetaInfo.tm_duration = docDurationUs;
  const nowSec = Math.floor(nowMs / 1e3);
  const metaEntries = usedAssetIds.map((assetId) => {
    const r = resolvedByAsset.get(assetId);
    if (!r) return null;
    const entry = materialByAsset.get(assetId);
    const kind = entry?.kind ?? subKindByAsset.get(assetId) ?? r.kind;
    const mat = entry ? (kind === "audio" ? audioMaterials : videoMaterials).find((m) => m.id === entry.materialId) : cropClones.find((c) => c.assetId === assetId)?.mat;
    const dur = kind === "photo" ? 0 : Number(mat?.duration) || us(r.durationUs);
    return {
      create_time: nowSec,
      duration: dur,
      extra_info: basenameOf2(r.absPath),
      file_Path: r.absPath,
      height: r.height && r.height > 0 ? Math.round(r.height) : 0,
      id: jyUuidUpper(),
      import_time: nowSec,
      import_time_ms: nowMs,
      item_source: 1,
      md5: "",
      metetype: kind === "photo" ? "photo" : kind === "audio" ? "music" : "video",
      roughcut_time_range: { duration: dur, start: 0 },
      sub_time_range: { duration: -1, start: -1 },
      type: 0,
      width: r.width && r.width > 0 ? Math.round(r.width) : 0
    };
  }).filter((e) => e !== null);
  const buckets = draftMetaInfo.draft_materials;
  const bucket0 = buckets.find((b) => b.type === 0);
  if (bucket0) bucket0.value = metaEntries;
  return { draftContent, draftMetaInfo, warnings, usedAssetIds, subdrafts };
}
function videoMaterialJson0(list, id, r) {
  const dur = r.kind === "photo" ? us(r.durationUs) || JY_PHOTO_DURATION_US : us(r.durationUs);
  list.push(videoMaterialJson(id, r, dur));
}
function textMaterialJson(id, style) {
  const content = {
    styles: [
      {
        fill: {
          alpha: 1,
          content: { render_type: "solid", solid: { alpha: 1, color: hexToRgb01(style.color, [1, 1, 1]) } }
        },
        range: [0, [...style.content].length],
        size: jyTextSize(style.fontSize),
        bold: false,
        italic: false,
        underline: false,
        strokes: [
          { content: { solid: { alpha: 1, color: hexToRgb01(style.strokeColor, [0, 0, 0]) } }, width: 0.08 }
        ]
      }
    ],
    text: style.content
  };
  return {
    id,
    content: JSON.stringify(content),
    typesetting: 0,
    alignment: 1,
    letter_spacing: 0,
    line_spacing: 0.02,
    line_feed: 1,
    line_max_width: 0.82,
    force_apply_line_max_width: false,
    check_flag: 15,
    type: "text",
    global_alpha: 1
  };
}
function buildTextSegmentJson(seg2, materialId, style, speeds) {
  const targetStart = us(seg2.targetStartUs);
  const targetDuration = us(seg2.targetDurationUs);
  const speedId = jyUuidHex();
  speeds.push({ curve_speed: null, id: speedId, mode: 0, speed: 1, type: "speed" });
  const r2 = (n) => Math.round(n * 100) / 100 + 0;
  const json = {
    enable_adjust: true,
    enable_color_correct_adjust: false,
    enable_color_curves: true,
    enable_color_match_adjust: false,
    enable_color_wheels: true,
    enable_lut: true,
    enable_smart_color_adjust: false,
    last_nonzero_volume: 1,
    reverse: false,
    track_attribute: 0,
    track_render_index: 0,
    visible: true,
    id: jyUuidHex(),
    material_id: materialId,
    target_timerange: { start: targetStart, duration: targetDuration },
    common_keyframes: [],
    keyframe_refs: [],
    source_timerange: null,
    speed: 1,
    volume: 1,
    extra_material_refs: [speedId],
    is_tone_modify: false,
    clip: {
      alpha: 1,
      flip: { horizontal: false, vertical: false },
      rotation: 0,
      scale: { x: 1, y: 1 },
      transform: { x: r2(style.x * 2), y: r2(-style.y * 2) }
    },
    uniform_scale: { on: true, value: 1 }
  };
  return { json, endUs: targetStart + targetDuration };
}
function transitionMaterialJson(id, tr) {
  return {
    category_id: "",
    category_name: "",
    duration: clampTransitionUs(tr.durationUs, tr.effectId),
    effect_id: tr.effectId,
    id,
    is_overlap: findJyTransition(tr.effectId)?.isOverlap ?? true,
    name: tr.name || "",
    platform: "all",
    resource_id: tr.resourceId,
    type: "transition"
  };
}

// <stdin>
var S = 1e6;
var seg = (id, extra = {}) => ({ id, kind: "media", media: "video", uri: "test://" + id, assetId: id, targetStartUs: 0, targetDurationUs: 10 * S, sourceStartUs: 0, sourceDurationUs: 10 * S, ...extra });
var track = (id, type, segments, extra = {}) => ({ id, type, segments, ...extra });
var doc = (...tracks) => ({ id: "fixture", name: "audit", fps: 30, tracks });
var a = seg("a", { keyframes: { x: [{ t: 0, v: 0 }, { t: 10 * S, v: 1 }] } });
var d = doc(track("v", "video", [a]));
var split = splitSegment(d, "a", 5 * S);
var right = split.tracks[0].segments[1];
var trim = trimSegment(d, "a", "start", 5 * S).tracks[0].segments[0];
var av = seg("a", { volume: 1.8 });
var volDoc = doc(track("v", "video", [av]));
var resolve = (id) => ({ absPath: "C:/fixture/" + id + ".mp4", kind: "video", durationUs: 10 * S, width: 1920, height: 1080 });
var volExport = buildDraftContent(volDoc, resolve);
var subtitle = seg("text", { media: void 0, assetId: void 0, uri: void 0, text: { content: "\u5B57\u5E55" } });
var textDoc = doc(track("txt", "text", [subtitle]), track("v", "video", [seg("a")]));
var compound = createCompound(textDoc, ["text", "a"], { segId: "compound", subDocId: "sub" });
var trans = JY_TRANSITIONS.find((x) => x.previewKind === "dissolve");
var ta = seg("ta", { targetDurationUs: 5 * S, sourceDurationUs: 5 * S, transitionAfter: { effectId: trans.effectId, resourceId: trans.resourceId, name: trans.name, durationUs: 1 * S } });
var tb = seg("tb", { targetStartUs: 5 * S, targetDurationUs: 5 * S, sourceDurationUs: 5 * S });
var td = doc(track("tv", "video", [ta, tb]));
var tc = createCompound(td, ["ta", "tb"], { segId: "tc", subDocId: "tsub" });
var locked = doc(track("locked", "video", [a], { locked: true }));
var compoundExport = buildDraftContent(compound, resolve);
var transformed = seg("transformed", { transform: { x: 0.25, y: 0, scaleX: 0.5, scaleY: 0.5, rotation: 30, opacity: 0.8 }, keyframes: { x: [{ t: 0, v: 0 }, { t: 10 * S, v: 1 }] }, transitionAfter: ta.transitionAfter });
var transformedCompound = createCompound(doc(track("t", "video", [transformed], { muted: true })), ["transformed"], { segId: "comp-transform", subDocId: "sub-transform" });
var transformedExport = buildDraftContent(transformedCompound, resolve);
var inline = transformedExport.draftContent.materials.drafts[0].draft;
console.log(JSON.stringify({
  splitKeyframe: { atAbs6sBefore: effectiveTransformAt(a, 6 * S).x, atAbs6sAfter: effectiveTransformAt(right, S).x },
  trimKeyframe: { atAbs6sBefore: effectiveTransformAt(a, 6 * S).x, atAbs6sAfter: effectiveTransformAt(trim, S).x },
  boostedVolume: { ui: av.volume, preview: effectiveVolumeAt(av, 0), exported: volExport.draftContent.tracks[0].segments[0].volume },
  compoundSubtitle: { hostType: compound.tracks.find((t) => t.segments.some((s) => s.id === "compound")).type, videoBefore: videoStageAt(textDoc, S).layers.length, videoAfter: videoStageAt(compound, S).layers.length, textBefore: activeTextSegments(textDoc, S).length, textAfter: activeTextSegments(compound, S).length, exportTrackCount: compoundExport.draftContent.tracks.length, exportWarnings: compoundExport.warnings },
  compoundExportLoss: { sourceTransform: transformed.transform, exportTransform: inline.tracks[0].segments[0].clip, sourceKeyframes: transformed.keyframes, exportKeyframes: inline.tracks[0].segments[0].common_keyframes ?? null, sourceTrackMuted: true, exportTrackAttribute: inline.tracks[0].attribute ?? null, warnings: transformedExport.warnings },
  compoundTransition: { before: videoStageAt(td, 4.75 * S).layers.map((x) => ({ id: x.trackId, ghost: x.ghost, fx: x.fx })), after: videoStageAt(tc, 4.75 * S).layers.map((x) => ({ id: x.trackId, ghost: x.ghost, fx: x.fx })) },
  lockBypass: { remainingAfterDelete: removeSegments(locked, ["a"]).tracks[0].segments.length, speedAfterSet: setSegmentSpeed(locked, "a", 2).tracks[0].segments[0].speed }
}, null, 2));
