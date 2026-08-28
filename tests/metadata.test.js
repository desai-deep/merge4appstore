import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverLocalizedMetadata, syncLocalizedMetadata } from '../lib/metadata.js';

function repository(entries, blobs) {
  return {
    getRepositoryTree: () => entries,
    getRepositoryBlob: sha => Buffer.from(blobs[sha] || ''),
  };
}

test('discovers optional text fields and alphabetizes screenshot and preview files', () => {
  const entries = [
    { path: 'AppStore/en-US/description.txt', type: 'blob', sha: 'description' },
    { path: 'AppStore/en-US/screenshots/APP_IPHONE_69', type: 'tree' },
    { path: 'AppStore/en-US/screenshots/APP_IPHONE_69/02.png', type: 'blob', sha: 'two' },
    { path: 'AppStore/en-US/screenshots/APP_IPHONE_69/01.png', type: 'blob', sha: 'one' },
    { path: 'AppStore/en-US/previews/IPHONE_65', type: 'tree' },
    { path: 'AppStore/en-US/previews/IPHONE_65/01.mov', type: 'blob', sha: 'video' },
  ];
  const metadata = discoverLocalizedMetadata(entries, 'AppStore', sha => Buffer.from(sha));

  assert.deepEqual(metadata.localizations['en-US'].attributes, { description: 'description' });
  assert.deepEqual(
    metadata.localizations['en-US'].screenshots.APP_IPHONE_69.map(asset => asset.fileName),
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
    findAppStoreVersionLocalization: async (_versionId, locale) => ({ id: `localization-${locale}` }),
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
    findAppStoreVersionLocalization: async () => ({ id: 'localization-1' }),
    updateAppStoreVersionLocalization: async () => {},
    syncScreenshotSet: async () => assert.fail('no screenshot set is managed'),
    syncPreviewSet: async () => assert.fail('no preview set is managed'),
  };
  const result = await syncLocalizedMetadata(asc, github, {
    metadataPath: 'AppStore', ref: 'abc', versionId: 'version-1',
  });
  assert.deepEqual([...result.managedWhatsNewLocales], []);
});
