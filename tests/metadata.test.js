import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLocalizedMetadata, syncLocalizedMetadata } from '../lib/metadata.js';

test('omitted localized fields and screenshot sets remain unmanaged', () => {
  assert.deepEqual(parseLocalizedMetadata(`
version: 1
localizations:
  en-US: {}
  de-DE:
    description: Beschreibung
`, 'AppStore/metadata.yml'), {
    version: 1,
    localizations: {
      'en-US': { attributes: {}, screenshots: {} },
      'de-DE': { attributes: { description: 'Beschreibung' }, screenshots: {} },
    },
  });
});

test('declared screenshot sets resolve inside the metadata directory and may be empty', () => {
  const metadata = parseLocalizedMetadata(`
version: 1
localizations:
  en-US:
    screenshots:
      APP_IPAD_PRO_3GEN_129:
        - screenshots/en-US/ipad/01.png
      APP_IPHONE_69: []
`, 'AppStore/metadata.yml');

  assert.deepEqual(metadata.localizations['en-US'].screenshots, {
    APP_IPAD_PRO_3GEN_129: ['AppStore/screenshots/en-US/ipad/01.png'],
    APP_IPHONE_69: [],
  });
});

test('rejects screenshot paths that escape the metadata directory', () => {
  assert.throws(() => parseLocalizedMetadata(`
version: 1
localizations:
  en-US:
    screenshots:
      APP_IPAD_PRO_3GEN_129:
        - ../secret.png
`, 'AppStore/metadata.yml'), /escapes the repository metadata directory/);
});

test('syncs only explicitly declared metadata and screenshot sets', async () => {
  const files = new Map([
    ['AppStore/metadata.yml', Buffer.from(`
version: 1
localizations:
  en-US: {}
  de-DE:
    promotional_text: Neu
    screenshots:
      APP_IPAD_PRO_3GEN_129:
        - screenshots/de-DE/ipad/01.png
`)],
    ['AppStore/screenshots/de-DE/ipad/01.png', Buffer.from('image')],
  ]);
  const github = { getRepositoryFile: file => files.get(file) };
  const calls = [];
  const asc = {
    findAppStoreVersionLocalization: async (_versionId, locale) => {
      calls.push(`find:${locale}`);
      return { id: `localization-${locale}` };
    },
    updateAppStoreVersionLocalization: async (id, attributes) => {
      calls.push({ id, attributes });
    },
    syncScreenshotSet: async (id, displayType, assets) => {
      calls.push({ id, displayType, assets });
      return { kept: 0, uploaded: 1, removed: 0 };
    },
  };

  const result = await syncLocalizedMetadata(asc, github, {
    metadataPath: 'AppStore/metadata.yml',
    ref: 'abc123',
    versionId: 'version-1',
  });

  assert.equal(result.enabled, true);
  assert.deepEqual(calls.slice(0, 2), [
    'find:de-DE',
    { id: 'localization-de-DE', attributes: { promotionalText: 'Neu' } },
  ]);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].displayType, 'APP_IPAD_PRO_3GEN_129');
  assert.equal(calls[2].assets[0].fileName, '01.png');
  assert.equal(calls[2].assets[0].checksum, '78805a221a988e79ef3f42d7c5bfd418');
});

test('an explicitly empty screenshot set is authoritative', async () => {
  const github = { getRepositoryFile: () => Buffer.from(`
version: 1
localizations:
  en-US:
    screenshots:
      APP_IPAD_PRO_3GEN_129: []
`) };
  let desired = null;
  const asc = {
    findAppStoreVersionLocalization: async () => ({ id: 'localization-1' }),
    syncScreenshotSet: async (_id, _displayType, assets) => {
      desired = assets;
      return { kept: 0, uploaded: 0, removed: 2 };
    },
  };

  await syncLocalizedMetadata(asc, github, {
    metadataPath: 'AppStore/metadata.yml', ref: 'abc', versionId: 'version-1',
  });
  assert.deepEqual(desired, []);
});
