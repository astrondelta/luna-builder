// Runs against Luna.MockEngine: no LUNA needed. `npm test`. tests/setup.ts defines the Luna
// global that src/ reads.
import { describe, expect, it } from 'vitest';
import {
  dropTree,
  fileUrl,
  formatDuration,
  importSample,
  indexDrop,
  indexFolder,
  isAudio,
  listError,
  listFolder,
  matches,
  parentIndex,
  peaks,
  rootFolders,
  searchRows,
  stepRow,
  treeRows,
  type Loaded,
  type TreeRow,
} from '../src/logic';

async function connected() {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: ['Vocal'] });
  engine.folders['/Samples'] = ['Kicks/', 'snare 01.wav', 'notes.txt', 'loop.aif', '.DS_Store'];
  engine.folders['/Samples/Kicks'] = ['Hard/', 'kick 1.wav', 'kick 2.wav'];
  engine.folders['/Samples/Kicks/Hard'] = ['kick hard.wav'];
  engine.folders['/Private'] = ['secret.wav'];
  engine.grantFolder('/Samples');
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  return { engine, luna, session };
}

const describeRows = (rows: TreeRow[]) =>
  rows.map((r) => '  '.repeat(r.depth) + (r.type === 'folder' ? `${r.expanded ? '▾' : '▸'} ${r.name}` : r.type === 'sample' ? r.sample.name : `(${r.text})`));

describe('folders', () => {
  it('lists subfolders and audio files, leaving out the rest', async () => {
    const { luna } = await connected();
    const c = await listFolder(luna.gui, '/Samples');
    expect(c.folders).toEqual([{ key: '/Samples/Kicks', name: 'Kicks', path: '/Samples/Kicks' }]);
    expect(c.samples.map((s) => s.name).sort()).toEqual(['loop.aif', 'snare 01.wav']);
    expect(c.other).toBe(1); // notes.txt; .DS_Store is hidden by LUNA
  });

  it('explains a folder LUNA was not given', async () => {
    const { luna } = await connected();
    const err = await listFolder(luna.gui, '/Private').catch((e) => e);
    expect(listError(err)).toMatch(/only list folders you gave it/);
  });

  it('adds a folder chosen in LUNA’s dialog', async () => {
    const { engine, luna } = await connected();
    engine.folders['/Drums'] = ['hat.wav'];
    engine.nextDialogFiles = ['/Drums'];
    const [folder] = await luna.gui.chooseFolders();
    expect(folder).toBe('/Drums');
    expect((await listFolder(luna.gui, folder)).samples.map((s) => s.name)).toEqual(['hat.wav']);
  });

  it('merges blessed and added folders into sorted roots, minus removed ones', () => {
    const roots = rootFolders(['/b/Samples', '/a/Loops/'], ['/b/Samples', '/c/drums', '/d/Old'], ['/d/Old']);
    expect(roots.map((r) => r.key)).toEqual(['/c/drums', '/a/Loops', '/b/Samples']);
    expect(roots[0]).toEqual({ key: '/c/drums', name: 'drums', path: '/c/drums' });
  });
});

describe('tree', () => {
  it('expands roots and subfolders independently', async () => {
    const { engine, luna } = await connected();
    engine.folders['/Loops'] = ['Drums/', 'pad.wav'];
    engine.folders['/Loops/Drums'] = [];
    engine.grantFolder('/Loops');
    const roots = rootFolders(['/Samples', '/Loops'], [], []);
    const loaded = new Map<string, Loaded>();
    for (const p of ['/Samples', '/Samples/Kicks', '/Loops', '/Loops/Drums'])
      loaded.set(p, { state: 'ok', contents: await listFolder(luna.gui, p) });

    expect(describeRows(treeRows(roots, new Set(), loaded))).toEqual(['▸ Loops', '▸ Samples']);
    expect(describeRows(treeRows(roots, new Set(['/Samples', '/Samples/Kicks', '/Loops', '/Loops/Drums']), loaded))).toEqual([
      '▾ Loops',
      '  ▾ Drums',
      '    (No audio files)',
      '  pad.wav',
      '▾ Samples',
      '  ▾ Kicks',
      '    ▸ Hard',
      '    kick 1.wav',
      '    kick 2.wav',
      '  loop.aif',
      '  snare 01.wav',
    ]);
  });

  it('shows loading and errors inside the folder', () => {
    const roots = rootFolders(['/A', '/B'], [], []);
    const loaded = new Map<string, Loaded>([['/B', { state: 'error', message: 'nope' }]]);
    const rows = treeRows(roots, new Set(['/A', '/B']), loaded);
    expect(describeRows(rows)).toEqual(['▾ A', '  (Loading…)', '▾ B', '  (nope)']);
    expect(rows[3]).toMatchObject({ type: 'note', error: true });
  });

  it('builds a tree for a dropped folder', () => {
    const f = (name: string) => new File([new Uint8Array(1)], name);
    const tree = dropTree('drop:1', [
      { file: f('a.wav'), relativePath: 'a.wav' },
      { file: f('k1.wav'), relativePath: 'Kicks/k1.wav' },
      { file: f('h.wav'), relativePath: 'Kicks/Hard/h.wav' },
    ]);
    const root = { key: 'drop:1', name: 'Pack' };
    const loaded = new Map<string, Loaded>([...tree].map(([k, contents]) => [k, { state: 'ok', contents } as Loaded]));
    expect(describeRows(treeRows([root], new Set(['drop:1', 'drop:1/Kicks', 'drop:1/Kicks/Hard']), loaded))).toEqual([
      '▾ Pack',
      '  ▾ Kicks',
      '    ▾ Hard',
      '      h.wav',
      '    k1.wav',
      '  a.wav',
    ]);
    expect(indexDrop(root, tree).map((h) => `${h.context}/${h.sample.name}`)).toEqual(['Pack/a.wav', 'Pack/Kicks/k1.wav', 'Pack/Kicks/Hard/h.wav']);
  });

  it('moves over notes and finds parents', () => {
    const rows = treeRows(rootFolders(['/A', '/B'], [], []), new Set(['/A']), new Map());
    // ▾ A, (Loading…), ▸ B
    expect(stepRow(rows, 0, 1)).toBe(2);
    expect(stepRow(rows, 2, -1)).toBe(0);
    expect(stepRow(rows, 2, 1)).toBe(2);
    expect(stepRow(rows, -1, 1)).toBe(0);
    expect(parentIndex(rows, 1)).toBe(0);
    expect(parentIndex(rows, 0)).toBe(-1);
  });
});

describe('search', () => {
  it('searches every file below a root, by name and folder', async () => {
    const { luna } = await connected();
    const { hits, truncated } = await indexFolder(luna.gui, { key: '/Samples', name: 'Samples', path: '/Samples' });
    expect(truncated).toBe(false);
    const found = (q: string) => searchRows(hits, q).map((r) => (r.type === 'sample' ? `${r.context}/${r.sample.name}` : ''));
    expect(found('hard')).toEqual(['Samples/Kicks/Hard/kick hard.wav']);
    expect(found('kicks 2')).toEqual(['Samples/Kicks/kick 2.wav']);
    expect(found('snare')).toEqual(['Samples/snare 01.wav']);
  });
});

describe('importing', () => {
  it('imports a sample by path onto a new track at the playhead, as one undo step', async () => {
    const { engine, session } = await connected();
    engine.mediaFiles['/Samples/snare 01.wav'] = true;
    const placed = await importSample(session, { kind: 'path', name: 'snare 01.wav', path: '/Samples/snare 01.wav' });
    await engine.settled();
    expect(placed.name).toBe('snare 01');
    expect(placed.startTick).toBe(0);
    expect(session.tracks.byId(placed.trackId)?.name.value).toBe('snare 01');
    expect(engine.transactions).toEqual(['begin', 'commit']);
    expect(engine.requests.some((r) => r.path.endsWith('/import_file'))).toBe(true);
  });
});

describe('helpers', () => {
  it('recognises audio files', () => {
    expect(['a.wav', 'b.AIFF', 'c.aif', 'd.flac', 'e.mp3'].every(isAudio)).toBe(true);
    expect(['a.txt', 'wav', 'b.wav.asd'].some(isAudio)).toBe(false);
  });

  it('escapes paths as file URLs for dragging', () => {
    expect(fileUrl('/Samples/snare 01.wav')).toBe('file:///Samples/snare%2001.wav');
    expect(fileUrl('C:\\Samples\\a b.wav')).toBe('file:///C:/Samples/a%20b.wav');
  });

  it('filters by every search term', () => {
    expect(matches('Kick Hard 01.wav', 'kick 01')).toBe(true);
    expect(matches('Kick Hard 01.wav', 'kick snare')).toBe(false);
    expect(matches('anything', '  ')).toBe(true);
  });

  it('reduces audio to min/max peaks', () => {
    const left = new Float32Array([0, 0.5, -0.25, 0, 1, -1, 0, 0]);
    expect(Array.from(peaks([left], 4))).toEqual([0, 0.5, -0.25, 0, -1, 1, 0, 0]);
  });

  it('formats durations', () => {
    expect(formatDuration(1.25)).toBe('0:01.3');
    expect(formatDuration(75)).toBe('1:15.0');
  });
});
