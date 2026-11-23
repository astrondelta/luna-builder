// Sample Browser: logic that does not touch the DOM, so tests can exercise it against
// Luna.MockEngine. main.ts turns what these return into DOM and sound.
//
// `Luna` is the global that vendor/luna.global.js defines; tsconfig.json types it through
// "@uaudio/luna-builder-sdk/global". Do not import the SDK here: the page already loads it.

/** The manifest's id: serveMediaFile serves files to this Add On's pages only. */
export const ADD_ON_ID = 'com.example.sample_browser';

/** Extensions LUNA imports and serveMediaFile serves as audio. */
export const AUDIO = /\.(wav|aiff?|mp3|flac|m4a|ogg|oga|opus)$/i;

export const isAudio = (name: string): boolean => AUDIO.test(name);

/** A file name without its extension. */
export const baseName = (name: string): string => name.replace(/\.[^.]+$/, '');

/** The last segment of a path. */
export function leafName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1) || trimmed;
}

/** A path as a file:// URL, for dragging a sample onto LUNA's timeline. */
export function fileUrl(path: string): string {
  const posix = path.replace(/\\/g, '/');
  const escaped = posix.split('/').map(encodeURIComponent).join('/');
  return 'file://' + (escaped.startsWith('/') ? escaped : '/' + escaped).replace(/^\/([A-Za-z])%3A/, '/$1:');
}

/** A sample the page can audition: known by path (inside LUNA) or as a dropped File. */
export type Sample =
  | { kind: 'path'; name: string; path: string }
  | { kind: 'file'; name: string; file: File; relativePath: string };

/** Identifies a sample across renders: its path, or its place in a drop. */
export const sampleKey = (s: Sample): string => (s.kind === 'path' ? s.path : `file:${s.relativePath}`);

/**
 * A folder in the tree. `key` identifies it: the absolute path for a folder on disk, or a
 * `drop:` key for one that came in a browser drop. Only folders on disk have a `path`.
 */
export interface FolderRef {
  key: string;
  name: string;
  path?: string;
}

/** What is directly inside a folder. */
export interface Contents {
  folders: FolderRef[];
  samples: Sample[];
  /** How many entries were left out because they are not audio. */
  other: number;
}

export type Loaded = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; contents: Contents };

/** One folder's subfolders and audio files, in LUNA's natural order. */
export async function listFolder(gui: Luna.Gui, path: string): Promise<Contents> {
  const entries = await gui.listFiles(path);
  const folders = entries.filter((e) => e.isDirectory);
  const audio = entries.filter((e) => !e.isDirectory && isAudio(e.name));
  return {
    folders: folders.map((e) => ({ key: e.path, name: e.name, path: e.path })),
    samples: audio.map((e) => ({ kind: 'path', name: e.name, path: e.path })),
    other: entries.length - folders.length - audio.length,
  };
}

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);

/**
 * The top-level folders: the blessed folders plus folders this browser added, minus the ones
 * the user removed from it, each once, sorted by name.
 */
export function rootFolders(blessed: readonly string[], added: readonly string[], removed: readonly string[]): FolderRef[] {
  const gone = new Set(removed.map(trimSlash));
  const paths = [...new Set([...blessed, ...added].map(trimSlash))].filter((p) => !gone.has(p));
  return paths
    .map((p) => ({ key: p, name: leafName(p), path: p }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.key.localeCompare(b.key));
}

/**
 * The folder tree for files dropped in a browser, which have no paths: each folder's
 * contents by key, the root at `rootKey`. `relativePath` is `/`-separated from the root.
 */
export function dropTree(rootKey: string, files: readonly { file: File; relativePath: string }[]): Map<string, Contents> {
  const tree = new Map<string, Contents>();
  const at = (key: string): Contents => {
    let c = tree.get(key);
    if (!c) tree.set(key, (c = { folders: [], samples: [], other: 0 }));
    return c;
  };
  at(rootKey);
  for (const { file, relativePath } of files) {
    const parts = relativePath.split('/').filter(Boolean);
    let key = rootKey;
    for (const dir of parts.slice(0, -1)) {
      const child = `${key}/${dir}`;
      const parent = at(key);
      if (!parent.folders.some((f) => f.key === child)) parent.folders.push({ key: child, name: dir });
      at(child);
      key = child;
    }
    at(key).samples.push({ kind: 'file', name: file.name, file, relativePath: `${rootKey}/${relativePath}` });
  }
  return tree;
}

export type TreeRow =
  | { type: 'folder'; key: string; name: string; path?: string; depth: number; expanded: boolean; root: boolean }
  | { type: 'sample'; key: string; sample: Sample; depth: number; context?: string }
  | { type: 'note'; key: string; depth: number; text: string; error?: boolean };

/** The rows the tree shows: every root, and inside each expanded folder its folders, then its samples. */
export function treeRows(roots: readonly FolderRef[], expanded: ReadonlySet<string>, loaded: ReadonlyMap<string, Loaded>): TreeRow[] {
  const out: TreeRow[] = [];
  const visit = (f: FolderRef, depth: number, root: boolean): void => {
    const open = expanded.has(f.key);
    out.push({ type: 'folder', key: f.key, name: f.name, path: f.path, depth, expanded: open, root });
    if (!open) return;
    const l = loaded.get(f.key);
    const note = (text: string, error = false): void => void out.push({ type: 'note', key: `${f.key}\u0000note`, depth: depth + 1, text, error });
    if (!l || l.state === 'loading') return note('Loading…');
    if (l.state === 'error') return note(l.message, true);
    for (const sub of l.contents.folders) visit(sub, depth + 1, false);
    for (const sample of l.contents.samples) out.push({ type: 'sample', key: sampleKey(sample), sample, depth: depth + 1 });
    if (!l.contents.folders.length && !l.contents.samples.length) note('No audio files');
  };
  for (const r of roots) visit(r, 0, true);
  return out;
}

/** The index of the folder row that holds row `index`, or -1 for a root. */
export function parentIndex(rows: readonly TreeRow[], index: number): number {
  const depth = rows[index]?.depth ?? 0;
  for (let i = index - 1; i >= 0; i--) if (rows[i].type === 'folder' && rows[i].depth < depth) return i;
  return -1;
}

/** Move from row `index` by `delta` to the next row that can be selected (not a note). */
export function stepRow(rows: readonly TreeRow[], index: number, delta: 1 | -1): number {
  const ok = (i: number) => rows[i] && rows[i].type !== 'note';
  if (!rows.some((_, i) => ok(i))) return -1;
  let i = index < 0 ? (delta > 0 ? -1 : rows.length) : index;
  for (i += delta; i >= 0 && i < rows.length; i += delta) if (ok(i)) return i;
  return index;
}

/** A sample found by search, with the folder it is in, starting at its root's name. */
export interface Hit {
  sample: Sample;
  context: string;
}

/** Every audio file below a root on disk, for search. */
export async function indexFolder(gui: Luna.Gui, root: FolderRef): Promise<{ hits: Hit[]; truncated: boolean }> {
  const { files, truncated } = await gui.listAllFiles(root.path!);
  const hits = files
    .filter((f) => !f.isDirectory && isAudio(f.name))
    .map((f): Hit => {
      const dir = f.relativePath.split('/').slice(0, -1).join('/');
      return { sample: { kind: 'path', name: f.name, path: f.path }, context: dir ? `${root.name}/${dir}` : root.name };
    });
  return { hits, truncated };
}

/** Every sample in a dropped tree, for search. */
export function indexDrop(root: FolderRef, tree: ReadonlyMap<string, Contents>): Hit[] {
  const hits: Hit[] = [];
  const walk = (key: string, context: string): void => {
    const c = tree.get(key);
    if (!c) return;
    for (const s of c.samples) hits.push({ sample: s, context });
    for (const f of c.folders) walk(f.key, `${context}/${f.name}`);
  };
  walk(root.key, root.name);
  return hits;
}

/** Search results as rows: samples whose name or folder matches every term, at most `limit`. */
export function searchRows(hits: readonly Hit[], query: string, limit = 500): TreeRow[] {
  const out: TreeRow[] = [];
  for (const h of hits) {
    if (!matches(`${h.context}/${h.sample.name}`, query)) continue;
    out.push({ type: 'sample', key: sampleKey(h.sample), sample: h.sample, depth: 0, context: h.context });
    if (out.length >= limit) break;
  }
  return out;
}

/** Why a folder could not be listed, in words for the status line. */
export function listError(e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code === 'uasrv.not_permitted') return 'LUNA can only list folders you gave it. Add this folder, or drop it here.';
  if (code === 'uasrv.filesystem_error') return 'That folder is gone, or LUNA cannot read it.';
  if (code === 'uasrv.invalid_value') return 'Not a folder.';
  if (e instanceof Luna.Unsupported) return 'This LUNA cannot list folders. Update LUNA, or drop samples here.';
  return (e as Error)?.message ?? String(e);
}

/** Every whitespace-separated term in `query` appears in the name, ignoring case. */
export function matches(name: string, query: string): boolean {
  const lower = name.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => lower.includes(term));
}

/**
 * Min/max pairs for drawing a waveform `buckets` wide, over all channels.
 * Returns [min0, max0, min1, max1, ...] in -1..1.
 */
export function peaks(channels: readonly Float32Array[], buckets: number): Float32Array {
  const out = new Float32Array(buckets * 2);
  const length = channels[0]?.length ?? 0;
  if (!length || buckets <= 0) return out;
  const per = length / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * per);
    const to = Math.max(from + 1, Math.floor((b + 1) * per));
    let lo = 0;
    let hi = 0;
    for (const ch of channels) {
      for (let i = from; i < to && i < length; i++) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    out[b * 2] = lo;
    out[b * 2 + 1] = hi;
  }
  return out;
}

/** `m:ss.t` for a duration in seconds. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Where an imported clip goes: the live playhead while playing, the resting one when stopped. */
export function playheadTick(session: Luna.Session): number {
  const t = session.transport;
  const tick = (t.playing.value ? t.location.value?.tick : undefined) ?? t.playStart.value ?? 0;
  return Math.max(0, Math.round(tick));
}

export interface Placed {
  trackId: string;
  name: string;
  startTick: number;
}

/**
 * Put a source on a new audio track at the playhead, named after the sample, as one undo step.
 */
export async function placeOnNewTrack(session: Luna.Session, source: Luna.AudioSource, fileName: string): Promise<Placed> {
  const name = baseName(source.name.value ?? fileName);
  const ns = source.length.value ?? 0;
  const timeline = session.musical.timeline;
  const startTick = playheadTick(session);
  // The exact span for an unstretched source, walked through the tempo map.
  const stopTick = Math.max(startTick + 1, Math.round(timeline.tickAtSeconds(timeline.seconds(startTick) + ns / 1e9)));
  let trackId = '';
  await session.transaction(`Import ${name}`, async () => {
    const [track] = await session.newTrack({
      name,
      trackType: 'audio',
      stemFormat: source.stemFormat.value === 'stereo' ? 'stereo' : 'mono',
      makeNameUnique: true,
    });
    trackId = track.id;
    await session.insertClip({ trackUid: track.id, sourceUid: source.id, startTick, stopTick, sourceStartNs: 0, sourceStopNs: ns, name });
  });
  return { trackId, name, startTick };
}

/**
 * Import a sample into the session and place it on a new track at the playhead. A path goes
 * through the engine (fast, no copy through the page); a dropped File is uploaded.
 */
export async function importSample(session: Luna.Session, sample: Sample): Promise<Placed> {
  await session.ready();
  const source =
    sample.kind === 'path' ? await session.importPath(sample.path) : await session.uploadFile({ bytes: sample.file });
  return placeOnNewTrack(session, source, sample.name);
}
