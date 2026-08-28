import crypto from 'crypto';
import path from 'path';
import YAML from 'yaml';
import { log } from './config.js';

const FIELD_MAP = {
  description: 'description',
  keywords: 'keywords',
  marketing_url: 'marketingUrl',
  promotional_text: 'promotionalText',
  support_url: 'supportUrl',
  whats_new: 'whatsNew',
};

function mapping(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value;
}

function repositoryAssetPath(manifestPath, assetPath) {
  if (typeof assetPath !== 'string' || assetPath.trim() === '') {
    throw new Error('Screenshot paths must be non-empty strings');
  }
  if (assetPath.includes('\\') || path.posix.isAbsolute(assetPath)) {
    throw new Error(`Screenshot path must be relative: ${assetPath}`);
  }
  const normalized = path.posix.normalize(assetPath);
  if (normalized !== assetPath || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Screenshot path escapes the repository metadata directory: ${assetPath}`);
  }
  const directory = path.posix.dirname(manifestPath);
  return path.posix.join(directory, normalized);
}

export function parseLocalizedMetadata(source, manifestPath = 'AppStore/metadata.yml') {
  const parsed = mapping(YAML.parse(source), 'Metadata manifest');
  if (parsed.version !== 1) throw new Error('Metadata manifest version must be 1');
  const allowedRoot = new Set(['version', 'localizations']);
  for (const key of Object.keys(parsed)) {
    if (!allowedRoot.has(key)) throw new Error(`Unsupported metadata key: ${key}`);
  }
  const localizations = mapping(parsed.localizations, 'localizations');
  const result = { version: 1, localizations: {} };

  for (const [locale, rawLocalization] of Object.entries(localizations)) {
    if (!locale.trim()) throw new Error('Localization locale must be non-empty');
    const localization = mapping(rawLocalization, `localizations.${locale}`);
    const attributes = {};
    const screenshots = {};
    const allowed = new Set([...Object.keys(FIELD_MAP), 'screenshots']);
    for (const key of Object.keys(localization)) {
      if (!allowed.has(key)) throw new Error(`Unsupported localized metadata field: ${locale}.${key}`);
    }
    for (const [sourceField, targetField] of Object.entries(FIELD_MAP)) {
      if (!Object.hasOwn(localization, sourceField)) continue;
      if (typeof localization[sourceField] !== 'string') {
        throw new Error(`localizations.${locale}.${sourceField} must be a string`);
      }
      attributes[targetField] = localization[sourceField];
    }

    if (Object.hasOwn(localization, 'screenshots')) {
      const sets = mapping(localization.screenshots, `localizations.${locale}.screenshots`);
      for (const [displayType, files] of Object.entries(sets)) {
        if (!displayType.trim()) throw new Error(`Screenshot display type for ${locale} must be non-empty`);
        if (!Array.isArray(files)) {
          throw new Error(`localizations.${locale}.screenshots.${displayType} must be a list`);
        }
        const resolved = files.map(file => repositoryAssetPath(manifestPath, file));
        if (new Set(resolved).size !== resolved.length) {
          throw new Error(`localizations.${locale}.screenshots.${displayType} contains duplicate files`);
        }
        const names = resolved.map(file => path.posix.basename(file));
        if (new Set(names).size !== names.length) {
          throw new Error(`localizations.${locale}.screenshots.${displayType} contains duplicate filenames`);
        }
        screenshots[displayType] = resolved;
      }
    }

    result.localizations[locale] = { attributes, screenshots };
  }
  return result;
}

function checksum(bytes) {
  return crypto.createHash('md5').update(bytes).digest('hex');
}

export async function syncLocalizedMetadata(asc, github, {
  metadataPath,
  ref,
  versionId,
  dryRun = false,
} = {}) {
  if (!metadataPath) return { enabled: false, managedWhatsNewLocales: new Set() };

  const source = github.getRepositoryFile(metadataPath, ref).toString('utf8');
  const manifest = parseLocalizedMetadata(source, metadataPath);
  const managedWhatsNewLocales = new Set();

  for (const [locale, localization] of Object.entries(manifest.localizations)) {
    if (Object.hasOwn(localization.attributes, 'whatsNew')) managedWhatsNewLocales.add(locale);
    const declaredSets = Object.entries(localization.screenshots);
    const hasChanges = Object.keys(localization.attributes).length > 0 || declaredSets.length > 0;
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

    if (Object.keys(localization.attributes).length > 0) {
      if (dryRun) log(`[DRY RUN] Would update localized metadata for ${locale}`);
      else {
        await asc.updateAppStoreVersionLocalization(target.id, localization.attributes);
        log(`Updated localized metadata for ${locale}`);
      }
    }

    for (const [displayType, files] of declaredSets) {
      const desired = files.map(file => {
        const bytes = github.getRepositoryFile(file, ref);
        return {
          path: file,
          fileName: path.posix.basename(file),
          bytes,
          checksum: checksum(bytes),
        };
      });
      const result = await asc.syncScreenshotSet(target.id, displayType, desired, dryRun);
      const action = dryRun ? 'Would sync' : 'Synced';
      log(`${dryRun ? '[DRY RUN] ' : ''}${action} ${locale}/${displayType}: ${result.kept} kept, ${result.uploaded} uploaded, ${result.removed} removed`);
    }
  }

  return { enabled: true, managedWhatsNewLocales };
}
