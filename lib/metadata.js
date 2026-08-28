import crypto from 'crypto';
import path from 'path';
import { log } from './config.js';

const TEXT_FIELDS = {
  'description.txt': 'description',
  'keywords.txt': 'keywords',
  'marketing_url.txt': 'marketingUrl',
  'promotional_text.txt': 'promotionalText',
  'support_url.txt': 'supportUrl',
  'whats_new.txt': 'whatsNew',
};
const MEDIA = {
  screenshots: { extensions: new Set(['.png', '.jpg', '.jpeg']) },
  previews: { extensions: new Set(['.mov', '.mp4', '.m4v']) },
};

function compareNames(left, right) {
  return left.fileName < right.fileName ? -1 : left.fileName > right.fileName ? 1 : 0;
}

function checksum(bytes) {
  return crypto.createHash('md5').update(bytes).digest('hex');
}

export function discoverLocalizedMetadata(entries, metadataRoot = 'AppStore', readBlob) {
  const root = metadataRoot.replace(/\/+$/, '');
  const localizations = {};
  const localization = locale => (localizations[locale] ||= {
    attributes: {}, screenshots: {}, previews: {},
  });

  for (const entry of entries) {
    if (entry.path === root) continue;
    const relative = entry.path.slice(root.length + 1);
    const parts = relative.split('/');
    if (parts.length === 2 && entry.type === 'blob' && TEXT_FIELDS[parts[1]]) {
      const bytes = readBlob(entry.sha);
      localization(parts[0]).attributes[TEXT_FIELDS[parts[1]]] = bytes
        .toString('utf8')
        .replace(/\r?\n$/, '');
      continue;
    }

    const [locale, kind, displayType] = parts;
    if (!locale || !MEDIA[kind] || !displayType || parts.length < 3) continue;
    const sets = localization(locale)[kind];
    sets[displayType] ||= [];
    if (entry.type !== 'blob' || parts.length !== 4) continue;
    const fileName = parts[3];
    if (fileName.startsWith('.')) continue;
    const extension = path.posix.extname(fileName).toLowerCase();
    if (!MEDIA[kind].extensions.has(extension)) {
      throw new Error(`Unsupported ${kind} file: ${entry.path}`);
    }
    const bytes = readBlob(entry.sha);
    sets[displayType].push({
      path: entry.path,
      fileName,
      bytes,
      checksum: checksum(bytes),
    });
  }

  for (const value of Object.values(localizations)) {
    for (const sets of [value.screenshots, value.previews]) {
      for (const assets of Object.values(sets)) {
        assets.sort(compareNames);
        const names = assets.map(asset => asset.fileName);
        if (new Set(names).size !== names.length) {
          throw new Error('Media filenames must be unique within each locale and display type');
        }
      }
    }
  }
  return { localizations };
}

export async function syncLocalizedMetadata(asc, github, {
  metadataPath,
  ref,
  versionId,
  dryRun = false,
} = {}) {
  if (!metadataPath) return { enabled: false, managedWhatsNewLocales: new Set() };

  const entries = github.getRepositoryTree(metadataPath, ref);
  const metadata = discoverLocalizedMetadata(
    entries,
    metadataPath,
    sha => github.getRepositoryBlob(sha),
  );
  const managedWhatsNewLocales = new Set();

  for (const [locale, value] of Object.entries(metadata.localizations)) {
    if (Object.hasOwn(value.attributes, 'whatsNew')) managedWhatsNewLocales.add(locale);
    const screenshotSets = Object.entries(value.screenshots);
    const previewSets = Object.entries(value.previews);
    const hasChanges = Object.keys(value.attributes).length > 0
      || screenshotSets.length > 0
      || previewSets.length > 0;
    if (!hasChanges) continue;

    let target = await asc.findAppStoreVersionLocalization(versionId, locale);
    if (!target && dryRun) {
      log(`[DRY RUN] Would create App Store localization ${locale}`);
      continue;
    }
    if (!target) {
      target = await asc.createAppStoreVersionLocalization(versionId, locale);
      log(`Created App Store localization ${locale}`);
    }

    if (Object.keys(value.attributes).length > 0) {
      if (dryRun) log(`[DRY RUN] Would update localized metadata for ${locale}`);
      else {
        await asc.updateAppStoreVersionLocalization(target.id, value.attributes);
        log(`Updated localized metadata for ${locale}`);
      }
    }

    for (const [displayType, assets] of screenshotSets) {
      const result = await asc.syncScreenshotSet(target.id, displayType, assets, dryRun);
      log(`${dryRun ? '[DRY RUN] Would sync' : 'Synced'} screenshots ${locale}/${displayType}: ${result.kept} kept, ${result.uploaded} uploaded, ${result.removed} removed`);
    }
    for (const [previewType, assets] of previewSets) {
      const result = await asc.syncPreviewSet(target.id, previewType, assets, dryRun);
      log(`${dryRun ? '[DRY RUN] Would sync' : 'Synced'} previews ${locale}/${previewType}: ${result.kept} kept, ${result.uploaded} uploaded, ${result.removed} removed`);
    }
  }

  return { enabled: true, managedWhatsNewLocales };
}
