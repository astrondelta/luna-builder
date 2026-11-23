// Sample Browser: DOM wiring. A tree of the folders LUNA was given (and folders dropped in a
// browser), each expandable in place; auditions samples in the page with Web Audio, and
// imports or drags them into the session. Engine logic lives in logic.ts.
//
// npm run build bundles this file and everything it imports into dist/main.js, one classic
// script (an IIFE) that index.html loads after vendor/luna.global.js.

import {
  ADD_ON_ID,
  dropTree,
  fileUrl,
  formatDuration,
  importSample,
  indexDrop,
  indexFolder,
  isAudio,
  leafName,
  listError,
  listFolder,
  parentIndex,
  peaks,
  rootFolders,
  sampleKey,
  searchRows,
  stepRow,
  treeRows,
  type Contents,
  type FolderRef,
  type Hit,
  type Loaded,
  type Sample,
  type TreeRow,
} from './logic';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`index.html has no #${id}`);
  return el as T;
}

// ---------------------------------------------------------------------------------------------
// Per-viewer preferences (web storage, namespaced by the Add On id)

const pref = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`${ADD_ON_ID}.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`${ADD_ON_ID}.${key}`, value);
    } catch {
      /* private mode or blocked storage: preferences just do not stick */
    }
  },
  list(key: string): string[] {
    try {
      const v = JSON.parse(pref.get(key) ?? '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  },
  setList(key: string, value: Iterable<string>): void {
    pref.set(key, JSON.stringify([...value]));
  },
};

// ---------------------------------------------------------------------------------------------
// State

let luna: Luna.Client | undefined;
let session: Luna.Session | undefined;
let guiReady = false;

/** Folders added here that LUNA does not list as blessed (one picked inside a blessed folder). */
let added = pref.list('added');
/** Blessed folders the user took out of this browser; LUNA keeps them for other Add Ons. */
let removed = pref.list('removed');
/** Expanded folder keys. Only folders on disk are remembered. */
const expanded = new Set<string>(pref.list('expanded'));
/** Folders dropped in a browser, which exist only until the page reloads. */
const dropRoots: FolderRef[] = [];
let dropCount = 0;
/** Each folder's contents, by key, once asked for. */
const loaded = new Map<string, Loaded>();
/** Search index per root key. */
const indexes = new Map<string, Promise<{ hits: Hit[]; truncated: boolean }>>();

let rows: TreeRow[] = [];
let selectedKey: string | undefined;

function status(text: string, isError = false): void {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

const query = (): string => $<HTMLInputElement>('search').value.trim();

function roots(): FolderRef[] {
  const disk = guiReady ? rootFolders(luna?.gui.blessedFolders.value ?? [], added, removed) : [];
  return [...disk, ...dropRoots];
}

function saveExpanded(): void {
  pref.setList('expanded', [...expanded].filter((k) => !k.startsWith('drop:')));
}

// ---------------------------------------------------------------------------------------------
// Audio: decode in the page and play through Web Audio. The SDK does not stream audio to
// LUNA, so previews play on the computer's default output, not through LUNA's mixer.

let ctx: AudioContext | undefined;
let gain: GainNode | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();
const MAX_CACHED = 32;

function audio(): { ctx: AudioContext; gain: GainNode } {
  if (!ctx) {
    ctx = new AudioContext();
    gain = ctx.createGain();
    gain.gain.value = Number($<HTMLInputElement>('volume').value);
    gain.connect(ctx.destination);
  }
  return { ctx, gain: gain! };
}

/** The bytes behind a URL from serveMediaFile. XMLHttpRequest: on Windows it is file:///, which fetch() refuses. */
function readBytes(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => (xhr.response ? resolve(xhr.response as ArrayBuffer) : reject(new Error(`cannot read ${url}`)));
    xhr.onerror = () => reject(new Error('cannot read the file (previews by path play inside LUNA only)'));
    xhr.send();
  });
}

async function bytesOf(sample: Sample): Promise<ArrayBuffer> {
  if (sample.kind === 'file') return sample.file.arrayBuffer();
  if (!luna) throw new Error('not connected to LUNA');
  // Ask every time: LUNA forgets what it served when it quits, so keep paths, not URLs.
  return readBytes(await luna.gui.serveMediaFile(ADD_ON_ID, sample.path));
}

function bufferOf(sample: Sample): Promise<AudioBuffer> {
  const key = sampleKey(sample);
  let p = buffers.get(key);
  if (p) {
    buffers.delete(key); // re-insert: most recently used last
  } else {
    p = bytesOf(sample).then((bytes) => audio().ctx.decodeAudioData(bytes));
    p.catch(() => buffers.delete(key));
  }
  buffers.set(key, p);
  while (buffers.size > MAX_CACHED) buffers.delete(buffers.keys().next().value!);
  return p;
}

interface Voice {
  src: AudioBufferSourceNode;
  key: string;
  startedAt: number;
  offset: number;
  duration: number;
}
let voice: Voice | undefined;
let auditionToken = 0;
let frame = 0;

function stop(): void {
  auditionToken++;
  if (voice) {
    voice.src.onended = null;
    try {
      voice.src.stop();
    } catch {
      /* already stopped */
    }
    voice = undefined;
  }
  paintTransport();
}

async function audition(sample: Sample, offsetFraction = 0): Promise<void> {
  stop();
  const token = auditionToken;
  const { ctx: c, gain: g } = audio();
  void c.resume();
  let buffer: AudioBuffer;
  try {
    buffer = await bufferOf(sample);
  } catch (e) {
    if (token === auditionToken) status(`${sample.name}: ${(e as Error).message ?? e}`, true);
    return;
  }
  if (token !== auditionToken) return; // another sample was picked meanwhile
  showWaveform(sample, buffer);
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(g);
  const offset = Math.min(buffer.duration, Math.max(0, offsetFraction * buffer.duration));
  src.start(0, offset);
  voice = { src, key: sampleKey(sample), startedAt: c.currentTime, offset, duration: buffer.duration };
  src.onended = () => {
    if (voice?.src === src) {
      voice = undefined;
      paintTransport();
    }
  };
  paintTransport();
}

/** Move the playhead with transform only: LUNA's web view repaints slowly (docs/DRAWING.md). */
function tick(): void {
  frame = 0;
  const head = $('playhead');
  if (!voice || !ctx || voice.key !== shownKey) {
    head.style.visibility = 'hidden';
    return;
  }
  const at = Math.min(1, (voice.offset + ctx.currentTime - voice.startedAt) / voice.duration);
  head.style.visibility = 'visible';
  head.style.transform = `translateX(${at * $('wave').clientWidth}px)`;
  frame = requestAnimationFrame(tick);
}

function paintTransport(): void {
  const playing = !!voice && voice.key === shownKey;
  $('play').textContent = playing ? '■' : '▶';
  $('play').title = playing ? 'Stop (Esc)' : 'Play (Enter)';
  for (const li of $('list').children) li.classList.toggle('playing', !!voice && (li as HTMLElement).dataset.sample === voice.key);
  if (!frame) frame = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------------------------
// Waveform of the selected sample

let shownKey: string | undefined;
let shownSample: Sample | undefined;
let shownBuffer: AudioBuffer | undefined;

function showWaveform(sample: Sample, buffer: AudioBuffer): void {
  shownKey = sampleKey(sample);
  shownSample = sample;
  shownBuffer = buffer;
  $('preview-name').textContent = sample.name;
  $('preview-name').title = sample.kind === 'path' ? sample.path : sample.relativePath;
  const ch = buffer.numberOfChannels;
  $('preview-info').textContent = `${formatDuration(buffer.duration)} · ${ch === 1 ? 'mono' : ch === 2 ? 'stereo' : `${ch} ch`} · ${(buffer.sampleRate / 1000).toFixed(1)} kHz`;
  drawWaveform();
  paintTransport();
}

function clearWaveform(): void {
  shownKey = undefined;
  shownSample = undefined;
  shownBuffer = undefined;
  $('preview-name').textContent = 'No sample selected';
  $('preview-info').textContent = '';
  drawWaveform();
  paintTransport();
}

function drawWaveform(): void {
  const canvas = $<HTMLCanvasElement>('wave');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, w, h);
  const mid = h / 2;
  g.fillStyle = getComputedStyle(canvas).getPropertyValue('--wave').trim() || '#F7C449';
  if (!shownBuffer) {
    g.fillRect(0, Math.floor(mid), w, Math.max(1, dpr));
    return;
  }
  const channels = Array.from({ length: shownBuffer.numberOfChannels }, (_, i) => shownBuffer!.getChannelData(i));
  const p = peaks(channels, w);
  for (let x = 0; x < w; x++) {
    const top = mid - p[x * 2 + 1] * mid * 0.95;
    const bottom = mid - p[x * 2] * mid * 0.95;
    g.fillRect(x, top, 1, Math.max(dpr, bottom - top));
  }
}

new ResizeObserver(() => drawWaveform()).observe($('wave'));

// ---------------------------------------------------------------------------------------------
// Loading folders

/** Load a folder on disk if it is expanded and not loaded yet. */
function ensureLoaded(folder: { key: string; path?: string }): void {
  if (!folder.path || loaded.has(folder.key) || !luna || !guiReady) return;
  loaded.set(folder.key, { state: 'loading' });
  listFolder(luna.gui, folder.path).then(
    (contents) => loaded.set(folder.key, { state: 'ok', contents }),
    (e) => loaded.set(folder.key, { state: 'error', message: listError(e) }),
  ).finally(() => render());
}

function toggle(row: Extract<TreeRow, { type: 'folder' }>, open = !row.expanded): void {
  if (open === row.expanded) return;
  if (open) expanded.add(row.key);
  else expanded.delete(row.key);
  saveExpanded();
  render();
}

/** Forget what was loaded under the folders on disk and read them again. */
function refresh(): void {
  for (const key of [...loaded.keys()]) if (!key.startsWith('drop:')) loaded.delete(key);
  for (const key of [...indexes.keys()]) if (!key.startsWith('drop:')) indexes.delete(key);
  render();
}

// ---------------------------------------------------------------------------------------------
// The tree

let searchToken = 0;

function render(): void {
  const q = query();
  if (q) return void renderSearch(q);
  rows = treeRows(roots(), expanded, loaded);
  paintRows(roots().length ? undefined : guiReady ? 'Add a folder of samples, or drop one here.' : 'Drop samples or a folder here.');
  for (const r of rows) if (r.type === 'folder' && r.expanded) ensureLoaded(r);
}

async function renderSearch(q: string): Promise<void> {
  const token = ++searchToken;
  const all = roots();
  for (const r of all) {
    if (indexes.has(r.key)) continue;
    if (r.path && luna) indexes.set(r.key, indexFolder(luna.gui, r).catch(() => ({ hits: [], truncated: false })));
    else {
      const tree = new Map<string, Contents>();
      for (const [k, l] of loaded) if (k === r.key || k.startsWith(r.key + '/')) if (l.state === 'ok') tree.set(k, l.contents);
      indexes.set(r.key, Promise.resolve({ hits: indexDrop(r, tree), truncated: false }));
    }
  }
  if (!rows.length || rows.some((r) => r.type === 'folder')) {
    rows = [];
    paintRows('Searching…');
  }
  const results = await Promise.all(all.map((r) => indexes.get(r.key)!));
  if (token !== searchToken || query() !== q) return;
  rows = searchRows(results.flatMap((r) => r.hits), q);
  const total = rows.length;
  paintRows(total ? undefined : 'Nothing matches.');
  const truncated = results.some((r) => r.truncated);
  status(`${total >= 500 ? '500+' : total} match${total === 1 ? '' : 'es'}` + (truncated ? ' (some large folders were only partly searched)' : ''));
}

function paintRows(emptyText?: string): void {
  const list = $('list');
  list.replaceChildren();
  if (!rows.length) {
    if (emptyText) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = emptyText;
      list.append(li);
    }
    return;
  }
  for (const row of rows) list.append(rowElement(row));
  paintSelection(false);
  paintTransport();
}

const INDENT = 14;

function rowElement(row: TreeRow): HTMLElement {
  const li = document.createElement('li');
  li.style.paddingLeft = `${6 + row.depth * INDENT}px`;
  li.dataset.key = row.key;
  li.onmousedown = (e) => e.preventDefault(); // keep keyboard focus on the list

  if (row.type === 'note') {
    li.className = 'note' + (row.error ? ' error' : '');
    li.textContent = row.text;
    li.style.paddingLeft = `${6 + row.depth * INDENT + 18}px`;
    return li;
  }

  li.setAttribute('role', 'treeitem');
  const icon = document.createElement('span');
  icon.className = 'icon';
  const name = document.createElement('span');
  name.className = 'name';
  li.append(icon, name);

  if (row.type === 'folder') {
    li.className = 'folder' + (row.root ? ' root' : '');
    li.setAttribute('aria-expanded', String(row.expanded));
    icon.textContent = row.expanded ? '▾' : '▸';
    name.textContent = row.name;
    if (row.path) name.title = row.path;
    li.onclick = () => {
      select(row.key);
      toggle(row);
    };
    if (row.root) {
      const x = document.createElement('button');
      x.className = 'row-btn';
      x.textContent = '×';
      x.title = row.path ? 'Remove from this browser (LUNA keeps access; see Settings > Add Ons > Folders)' : 'Remove';
      x.onclick = (e) => {
        e.stopPropagation();
        removeRoot(row);
      };
      li.append(x);
    }
    return li;
  }

  const sample = row.sample;
  li.className = 'sample';
  li.dataset.sample = row.key;
  icon.textContent = '♪';
  name.textContent = sample.name;
  name.title = sample.kind === 'path' ? sample.path : sample.relativePath;
  if (row.context) {
    const where = document.createElement('span');
    where.className = 'where';
    where.textContent = row.context;
    li.append(where);
  }
  li.onclick = () => {
    select(row.key);
    void audition(sample);
  };

  if (sample.kind === 'path') {
    // Drag out to LUNA's timeline: LUNA reads a dragged file:// URL or absolute path and
    // places the file on the lane, or a new track, where it lands.
    li.draggable = true;
    li.ondragstart = (e) => {
      e.dataTransfer!.effectAllowed = 'copy';
      e.dataTransfer!.setData('text/uri-list', fileUrl(sample.path));
      e.dataTransfer!.setData('text/plain', sample.path);
      li.classList.add('dragging');
    };
    li.ondragend = () => li.classList.remove('dragging');
  }

  const add = document.createElement('button');
  add.className = 'row-btn import';
  add.textContent = '+';
  add.disabled = !session;
  add.title = session ? 'Import onto a new track at the playhead (Shift+Enter)' : 'Open a session in LUNA first';
  add.onclick = (e) => {
    e.stopPropagation();
    void importOne(sample, add);
  };
  li.append(add);
  return li;
}

const selectedIndex = (): number => (selectedKey === undefined ? -1 : rows.findIndex((r) => r.key === selectedKey));

function paintSelection(scroll = true): void {
  const items = $('list').children;
  const i = selectedIndex();
  for (let j = 0; j < items.length; j++) items[j].classList.toggle('selected', j === i);
  if (scroll && i >= 0) (items[i] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
}

let previewToken = 0;

function select(key: string | undefined, scroll = true): void {
  selectedKey = key;
  paintSelection(scroll);
  const row = rows[selectedIndex()];
  if (row?.type === 'sample' && sampleKey(row.sample) !== shownKey) {
    // Decode ahead so the waveform shows even without auto-play.
    const token = ++previewToken;
    bufferOf(row.sample).then(
      (b) => token === previewToken && showWaveform(row.sample, b),
      () => undefined,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Adding and removing folders

function addRoot(path: string): void {
  removed = removed.filter((p) => p !== path);
  if (!(luna?.gui.blessedFolders.value ?? []).includes(path) && !added.includes(path)) added = [...added, path];
  pref.setList('added', added);
  pref.setList('removed', removed);
  loaded.delete(path);
  expanded.add(path);
  saveExpanded();
  $<HTMLInputElement>('search').value = '';
  render();
  select(path);
}

function removeRoot(row: Extract<TreeRow, { type: 'folder' }>): void {
  if (row.key.startsWith('drop:')) {
    const i = dropRoots.findIndex((r) => r.key === row.key);
    if (i >= 0) dropRoots.splice(i, 1);
    for (const k of [...loaded.keys()]) if (k === row.key || k.startsWith(row.key + '/')) loaded.delete(k);
  } else {
    added = added.filter((p) => p !== row.key);
    if ((luna?.gui.blessedFolders.value ?? []).includes(row.key)) removed = [...removed, row.key];
    pref.setList('added', added);
    pref.setList('removed', removed);
  }
  indexes.delete(row.key);
  expanded.delete(row.key);
  saveExpanded();
  render();
}

async function addFolder(): Promise<void> {
  if (!luna || !guiReady) return;
  try {
    const [folder] = await luna.gui.chooseFolders({ title: 'Choose a folder of samples' });
    if (folder) addRoot(folder);
  } catch (e) {
    status(listError(e), true);
  }
}

// ---------------------------------------------------------------------------------------------
// Importing

async function importOne(sample: Sample, button?: HTMLButtonElement): Promise<void> {
  if (!session) {
    status('Open a session in LUNA first.', true);
    return;
  }
  if (button) button.disabled = true;
  status(`Importing ${sample.name}…`);
  try {
    const placed = await importSample(session, sample);
    status(`Imported “${placed.name}” onto a new track at ${session.musical.timeline.formatBarBeat(placed.startTick)}.`);
  } catch (e) {
    status(`Import ${sample.name}: ${(e as Error).message ?? e}`, true);
  } finally {
    if (button) button.disabled = !session;
  }
}

function bindSession(): void {
  session = luna?.sessions.current();
  for (const b of document.querySelectorAll<HTMLButtonElement>('#list button.import')) {
    b.disabled = !session;
    b.title = session ? 'Import onto a new track at the playhead (Shift+Enter)' : 'Open a session in LUNA first';
  }
}

// ---------------------------------------------------------------------------------------------
// Drops: folders and files dragged onto the page

/** Add a drop root holding these samples, laid out by their relative paths. */
function addDropRoot(name: string, files: { file?: File; path?: string; relativePath: string }[]): void {
  const key = `drop:${++dropCount}`;
  dropRoots.push({ key, name });
  const withFiles = files.filter((f): f is { file: File; relativePath: string } => !!f.file);
  const tree = dropTree(key, withFiles);
  const top = tree.get(key)!;
  for (const f of files) if (f.path) top.samples.push({ kind: 'path', name: leafName(f.path), path: f.path });
  for (const [k, contents] of tree) loaded.set(k, { state: 'ok', contents });
  expanded.add(key);
  $<HTMLInputElement>('search').value = '';
  render();
  select(key);
}

/** Inside LUNA: dropped paths. A dropped folder becomes a root once the user allows it. */
function dropPaths(paths: string[]): void {
  const folders = paths.filter((p) => !isAudio(p));
  const files = paths.filter(isAudio);
  for (const f of folders) addRoot(f);
  if (files.length) addDropRoot('Dropped files', files.map((path) => ({ path, relativePath: leafName(path) })));
}

/** In a browser (or an older LUNA): dropped Files, walking any folders among them. */
async function dropFiles(transfer: DataTransfer): Promise<void> {
  const entries = Array.from(transfer.items)
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  const loose: { file: File; relativePath: string }[] = [];
  // No entries API (or a synthetic drop): take the plain files.
  if (!entries.length) for (const file of Array.from(transfer.files)) if (isAudio(file.name)) loose.push({ file, relativePath: file.name });

  const walk = async (entry: FileSystemEntry, prefix: string, out: { file: File; relativePath: string }[]): Promise<void> => {
    if (entry.isFile) {
      if (!isAudio(entry.name)) return;
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, relativePath: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children: FileSystemEntry[] = [];
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        children.push(...batch);
      }
      children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const child of children) if (!child.name.startsWith('.')) await walk(child, `${prefix}${entry.name}/`, out);
    }
  };

  // Each dropped folder becomes its own root; loose files share one.
  let roots = 0;
  for (const e of entries) {
    if (e.isDirectory) {
      const files: { file: File; relativePath: string }[] = [];
      await walk(e, '', files);
      const strip = e.name.length + 1;
      addDropRoot(e.name, files.map((f) => ({ file: f.file, relativePath: f.relativePath.slice(strip) })));
      roots++;
    } else await walk(e, '', loose);
  }
  if (loose.length) {
    addDropRoot('Dropped files', loose);
    roots++;
  }
  if (!roots) status('No audio files in that drop.', true);
}

function setUpHtmlDrop(): void {
  const body = document.body;
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  body.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    body.classList.add('drop-hot');
  });
  body.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) body.classList.remove('drop-hot');
  });
  // Without preventDefault() on dragover the browser refuses the drop.
  body.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  body.addEventListener('drop', (e) => {
    depth = 0;
    body.classList.remove('drop-hot');
    if (!hasFiles(e)) return;
    e.preventDefault();
    void dropFiles(e.dataTransfer!);
  });
}

// ---------------------------------------------------------------------------------------------
// Keyboard: ↑/↓ move, → opens or steps in, ← closes or steps out, Enter toggles or plays.
// Space and every other key we do not claim go on to LUNA (play, record, undo).

const autoplay = (): boolean => $<HTMLInputElement>('autoplay').checked;

function moveTo(index: number): void {
  const row = rows[index];
  if (!row) return;
  select(row.key);
  if (row.type === 'sample' && autoplay()) void audition(row.sample);
}

function onKey(e: KeyboardEvent): void {
  const inSearch = e.target === $('search');
  const i = selectedIndex();
  const row = rows[i];
  const handled = (): void => e.preventDefault();

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    handled();
    if (inSearch) $('list').focus();
    moveTo(stepRow(rows, i, e.key === 'ArrowDown' ? 1 : -1));
    return;
  }
  if (e.key === 'Escape') {
    handled();
    if (inSearch && query()) {
      $<HTMLInputElement>('search').value = '';
      render();
      paintSelection();
    } else stop();
    return;
  }
  if (inSearch) {
    if (e.key === 'Enter' && rows.length) {
      handled();
      $('list').focus();
      moveTo(i >= 0 ? i : stepRow(rows, -1, 1));
    }
    return;
  }
  if (e.key === 'Enter' && e.shiftKey && row?.type === 'sample') {
    handled();
    void importOne(row.sample);
  } else if (e.key === 'Enter' && row) {
    handled();
    if (row.type === 'folder') toggle(row);
    else if (row.type === 'sample') {
      if (voice?.key === row.key) stop();
      else void audition(row.sample);
    }
  } else if (e.key === 'ArrowRight' && row?.type === 'folder') {
    handled();
    if (!row.expanded) toggle(row, true);
    else if (rows[i + 1] && rows[i + 1].depth > row.depth) moveTo(stepRow(rows, i, 1));
  } else if (e.key === 'ArrowLeft' && row) {
    handled();
    if (row.type === 'folder' && row.expanded) toggle(row, false);
    else {
      const p = parentIndex(rows, i);
      if (p >= 0) select(rows[p].key);
    }
  } else if (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key === 'f')) {
    handled();
    $('search').focus();
  }
}

// ---------------------------------------------------------------------------------------------
// Start

function wireControls(): void {
  $('add').onclick = () => void addFolder();
  $('refresh').onclick = refresh;
  $('collapse').onclick = () => {
    expanded.clear();
    saveExpanded();
    render();
  };
  $('search').oninput = () => render();
  $('list').addEventListener('keydown', onKey);
  $('search').addEventListener('keydown', onKey);

  $('play').onclick = () => {
    if (voice && voice.key === shownKey) stop();
    else if (shownSample) void audition(shownSample);
  };
  $('wave').onclick = (e) => {
    if (!shownSample) return;
    const rect = $('wave').getBoundingClientRect();
    void audition(shownSample, (e.clientX - rect.left) / rect.width);
  };

  const auto = $<HTMLInputElement>('autoplay');
  auto.checked = pref.get('autoplay') !== '0';
  auto.onchange = () => pref.set('autoplay', auto.checked ? '1' : '0');

  const vol = $<HTMLInputElement>('volume');
  const savedVol = pref.get('volume');
  if (savedVol !== null && Number.isFinite(Number(savedVol))) vol.value = savedVol;
  vol.oninput = () => {
    if (gain) gain.gain.value = Number(vol.value);
    pref.set('volume', vol.value);
  };

  setUpHtmlDrop();
  render();
  clearWaveform();
}

async function connect(): Promise<void> {
  for (;;) {
    try {
      // Inside LUNA the page URL carries ?port=; in a browser this falls back to LUNA on localhost.
      luna = await Luna.connect();
      break;
    } catch (e) {
      status(
        e instanceof Luna.NotRunning ? 'Waiting for LUNA… (you can still drop samples here)' : String((e as Error).message ?? e),
        !(e instanceof Luna.NotRunning),
      );
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // LUNA's standard undo, redo, play and record keys outside LUNA; nothing inside it.
  Luna.bindShortcuts(luna);

  guiReady = await luna.gui.available();
  if (guiReady) {
    for (const id of ['add', 'refresh']) $<HTMLButtonElement>(id).disabled = false;
    await luna.gui.watchBlessedFolders();
    // A folder the user just allowed: retry the ones LUNA refused, then redraw.
    luna.gui.blessedFolders.onChange(() => {
      for (const [k, l] of [...loaded]) if (l.state === 'error') loaded.delete(k);
      render();
    });
    // Inside LUNA, LUNA claims file drags and hands the page their paths; a dropped folder is
    // one LUNA may list once the user allows it.
    if (Luna.canDropPaths()) Luna.onPathDrop({ drop: ({ paths }) => dropPaths(paths) });
  }

  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  bindSession();
  luna.status.onChange(() => {
    if (luna?.status.value === 'disconnected') status('Reconnecting to LUNA…', true);
  });

  // First run: open the first folder.
  const first = roots()[0];
  if (pref.get('expanded') === null && first) {
    expanded.add(first.key);
    saveExpanded();
  }
  render();
  status(
    !guiReady
      ? 'This LUNA cannot list folders. Drop samples or folders here instead.'
      : roots().length
        ? `${roots().length} folder${roots().length === 1 ? '' : 's'}`
        : 'Add a folder of samples to start.',
  );
}

wireControls();
void connect();
window.addEventListener('pagehide', () => {
  stop();
  void luna?.close();
});
