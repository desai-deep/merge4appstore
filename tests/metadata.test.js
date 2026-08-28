import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discoverLocalizedMetadata,
  imageDimensions,
  inferScreenshotDisplayType,
  syncLocalizedMetadata,
} from '../lib/metadata.js';

function repository(entries, blobs) {
  return {
    getRepositoryTree: () => [
      { path: 'AppStore', type: 'tree', sha: 'root' },
      ...entries.filter(entry => entry.path !== 'AppStore'),
    ],
    getRepositoryBlob: sha => Buffer.from(blobs[sha] || ''),
  };
}

function png(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test('infers screenshot sets from flat PNG dimensions in portrait or landscape', () => {
  assert.equal(inferScreenshotDisplayType(png(1320, 2868)), 'APP_IPHONE_67');
  assert.equal(inferScreenshotDisplayType(png(2752, 2064)), 'APP_IPAD_PRO_3GEN_129');
  assert.deepEqual(imageDimensions(png(1179, 2556)), { width: 1179, height: 2556 });
});

test('reads JPEG dimensions for flat screenshot inference', () => {
  const bytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    0x0a, 0xf0, 0x08, 0x10, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00,
  ]);
  assert.deepEqual(imageDimensions(bytes), { width: 2064, height: 2800 });
  assert.throws(() => inferScreenshotDisplayType(bytes), /unsupported screenshot dimensions/);
});

test('requires an explicit folder for dimensions shared by Apple TV and Vision Pro', () => {
  assert.throws(
    () => inferScreenshotDisplayType(png(3840, 2160), 'AppStore/en-US/screenshots/01.png'),
    /ambiguous.*APP_APPLE_TV.*APP_APPLE_VISION_PRO/,
  );
});

test('groups flat screenshots by inferred dimensions and alphabetizes each set', () => {
  const blobs = { one: png(2064, 2752), two: png(2064, 2752), phone: png(1320, 2868) };
  const metadata = discoverLocalizedMetadata([
    { path: 'AppStore/en-US/screenshots/02-ipad.png', type: 'blob', sha: 'two' },
    { path: 'AppStore/en-US/screenshots/01-ipad.png', type: 'blob', sha: 'one' },
    { path: 'AppStore/en-US/screenshots/01-phone.png', type: 'blob', sha: 'phone' },
  ], 'AppStore', sha => blobs[sha]);

  assert.deepEqual(
    metadata.localizations['en-US'].screenshots.APP_IPAD_PRO_3GEN_129.map(asset => asset.fileName),
    ['01-ipad.png', '02-ipad.png'],
  );
  assert.deepEqual(
    metadata.localizations['en-US'].screenshots.APP_IPHONE_67.map(asset => asset.fileName),
    ['01-phone.png'],
  );
});

test('discovers optional text fields and alphabetizes screenshot and preview files', () => {
  const entries = [
    { path: 'AppStore/en-US/description.txt', type: 'blob', sha: 'description' },
    { path: 'AppStore/en-US/screenshots/APP_IPHONE_67', type: 'tree' },
    { path: 'AppStore/en-US/screenshots/APP_IPHONE_67/02.png', type: 'blob', sha: 'two' },
    { path: 'AppStore/en-US/screenshots/APP_IPHONE_67/01.png', type: 'blob', sha: 'one' },
    { path: 'AppStore/en-US/previews/IPHONE_65', type: 'tree' },
    { path: 'AppStore/en-US/previews/IPHONE_65/01.mov', type: 'blob', sha: 'video' },
  ];
  const metadata = discoverLocalizedMetadata(entries, 'AppStore', sha => Buffer.from(sha));

  assert.deepEqual(metadata.localizations['en-US'].attributes, { description: 'description' });
  assert.deepEqual(
    metadata.localizations['en-US'].screenshots.APP_IPHONE_67.map(asset => asset.fileName),
    ['01.png', '02.png'],
  );
  assert.deepEqual(
    metadata.localizations['en-US'].previews.IPHONE_65.map(asset => asset.fileName),
    ['01.mov'],
  );
});

test('an existing media directory with only a hidden keep file is authoritative and empty', () => {
  const metadata = discoverLocalizedMetadata([
    { path: 'AppStore/en-US/screenshots/APP_IPAD_PRO_3GEN_129', type: 'tree' },
    { path: 'AppStore/en-US/screenshots/APP_IPAD_PRO_3GEN_129/.gitkeep', type: 'blob', sha: 'keep' },
  ], 'AppStore', () => Buffer.alloc(0));
  assert.deepEqual(metadata.localizations['en-US'].screenshots.APP_IPAD_PRO_3GEN_129, []);
});

test('accepts future Apple-style screenshot types in explicit directories', () => {
  const metadata = discoverLocalizedMetadata([
    { path: 'AppStore/en-US/screenshots/APP_IPHONE_FUTURE', type: 'tree' },
    { path: 'AppStore/en-US/screenshots/APP_IPHONE_FUTURE/01.png', type: 'blob', sha: 'image' },
  ], 'AppStore', () => Buffer.from('image'));
  assert.equal(metadata.localizations['en-US'].screenshots.APP_IPHONE_FUTURE.length, 1);

  assert.throws(() => discoverLocalizedMetadata([
    { path: 'AppStore/en-US/screenshots/not-an-apple-type', type: 'tree' },
  ], 'AppStore', () => Buffer.alloc(0)), /Invalid screenshot display type directory/);
});

test('rejects preview files without an explicit display-type directory', () => {
  assert.throws(() => discoverLocalizedMetadata([
    { path: 'AppStore/en-US/previews/01.mov', type: 'blob', sha: 'video' },
  ], 'AppStore', () => Buffer.from('video')), /require an explicit display-type directory/);
});

test('rejects unsupported files inside managed media directories', () => {
  assert.throws(() => discoverLocalizedMetadata([
    { path: 'AppStore/en-US/previews/IPHONE_65/readme.txt', type: 'blob', sha: 'bad' },
  ], 'AppStore', () => Buffer.alloc(0)), /Unsupported previews file/);
});

test('syncs only the text fields and media directories present in the tree', async () => {
  const github = repository([
    { path: 'AppStore/de-DE/promotional_text.txt', type: 'blob', sha: 'text' },
    { path: 'AppStore/de-DE/screenshots/APP_IPAD_PRO_3GEN_129', type: 'tree' },
    { path: 'AppStore/de-DE/screenshots/APP_IPAD_PRO_3GEN_129/01.png', type: 'blob', sha: 'image' },
    { path: 'AppStore/de-DE/previews/IPAD_PRO_3GEN_129', type: 'tree' },
    { path: 'AppStore/de-DE/previews/IPAD_PRO_3GEN_129/01.mov', type: 'blob', sha: 'video' },
  ], { text: 'Neu\n', image: 'image', video: 'video' });
  const calls = [];
  const asc = {
    getAppStoreVersionLocalizations: async () => ([
      { id: 'localization-de-DE', attributes: { locale: 'de-DE' } },
    ]),
    updateAppStoreVersionLocalization: async (id, attributes) => calls.push({ id, attributes }),
    syncScreenshotSet: async (id, displayType, assets) => {
      calls.push({ kind: 'screenshots', id, displayType, assets });
      return { kept: 0, uploaded: 1, removed: 0 };
    },
    syncPreviewSet: async (id, displayType, assets) => {
      calls.push({ kind: 'previews', id, displayType, assets });
      return { kept: 0, uploaded: 1, removed: 0 };
    },
  };

  const result = await syncLocalizedMetadata(asc, github, {
    metadataPath: 'AppStore', ref: 'abc123', versionId: 'version-1',
  });

  assert.equal(result.enabled, true);
  assert.deepEqual(calls[0], {
    id: 'localization-de-DE', attributes: { promotionalText: 'Neu' },
  });
  assert.equal(calls[1].kind, 'screenshots');
  assert.equal(calls[1].assets[0].checksum, '78805a221a988e79ef3f42d7c5bfd418');
  assert.equal(calls[2].kind, 'previews');
});

test('omitted media directories and release notes remain unmanaged', async () => {
  const github = repository([
    { path: 'AppStore/en-US/description.txt', type: 'blob', sha: 'text' },
  ], { text: 'Description' });
  const asc = {
    getAppStoreVersionLocalizations: async () => ([
      { id: 'localization-1', attributes: { locale: 'en-US' } },
    ]),
    updateAppStoreVersionLocalization: async () => {},
    syncScreenshotSet: async () => assert.fail('no screenshot set is managed'),
    syncPreviewSet: async () => assert.fail('no preview set is managed'),
  };
  const result = await syncLocalizedMetadata(asc, github, {
    metadataPath: 'AppStore', ref: 'abc', versionId: 'version-1',
  });
  assert.deepEqual([...result.managedWhatsNewLocales], []);
});

test('fails clearly when the configured metadata root is missing or is a file', async () => {
  const asc = {};
  await assert.rejects(syncLocalizedMetadata(asc, {
    getRepositoryTree: () => [],
  }, {
    metadataPath: 'AppStore', ref: 'abc', versionId: 'version-1',
  }), /Metadata directory AppStore does not exist at abc/);

  await assert.rejects(syncLocalizedMetadata(asc, {
    getRepositoryTree: () => [{ path: 'AppStore', type: 'blob', sha: 'file' }],
  }, {
    metadataPath: 'AppStore', ref: 'abc', versionId: 'version-1',
  }), /Metadata path AppStore is not a directory at abc/);
});
