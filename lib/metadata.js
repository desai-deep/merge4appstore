import crypto from 'crypto';
import path from 'path';
import { log } from './config.js';

const VERSION_LOCALIZATION_FIELDS = {
  'description.txt': 'description',
  'keywords.txt': 'keywords',
  'marketing_url.txt': 'marketingUrl',
  'promotional_text.txt': 'promotionalText',
  'support_url.txt': 'supportUrl',
  'whats_new.txt': 'whatsNew',
};
const APP_INFO_LOCALIZATION_FIELDS = {
  'name.txt': 'name',
  'subtitle.txt': 'subtitle',
  'privacy_policy_url.txt': 'privacyPolicyUrl',
  'privacy_choices_url.txt': 'privacyChoicesUrl',
  'privacy_policy_text.txt': 'privacyPolicyText',
};
const REVIEW_FIELDS = {
  'contact_first_name.txt': 'contactFirstName',
  'contact_last_name.txt': 'contactLastName',
  'contact_phone.txt': 'contactPhone',
  'contact_email.txt': 'contactEmail',
  'notes.txt': 'notes',
  'demo_account_name.txt': 'demoAccountName',
  'demo_account_password.txt': 'demoAccountPassword',
};
const MEDIA = {
  screenshots: { extensions: new Set(['.png', '.jpg', '.jpeg']) },
  previews: { extensions: new Set(['.mov', '.mp4', '.m4v']) },
};
const SCREENSHOT_DIMENSIONS = new Map();

function isScreenshotDisplayType(value) {
  return /^APP_[A-Z0-9_]+$/.test(value);
}

function dimensions(type, sizes) {
  for (const [width, height] of sizes) {
    const key = width < height ? `${width}x${height}` : `${height}x${width}`;
    const existing = SCREENSHOT_DIMENSIONS.get(key) || [];
    if (!existing.includes(type)) existing.push(type);
    SCREENSHOT_DIMENSIONS.set(key, existing);
  }
}

dimensions('APP_IPHONE_67', [[1260, 2736], [1290, 2796], [1320, 2868]]);
dimensions('APP_IPHONE_65', [[1284, 2778], [1242, 2688]]);
dimensions('APP_IPHONE_61', [[1179, 2556], [1206, 2622], [1170, 2532], [1080, 2340]]);
dimensions('APP_IPHONE_58', [[1125, 2436]]);
dimensions('APP_IPHONE_55', [[1242, 2208]]);
dimensions('APP_IPHONE_47', [[750, 1334]]);
dimensions('APP_IPHONE_40', [[640, 1096], [640, 1136], [600, 1136]]);
dimensions('APP_IPHONE_35', [[640, 920], [640, 960], [600, 960]]);
dimensions('APP_IPAD_PRO_3GEN_129', [[2064, 2752], [2048, 2732]]);
dimensions('APP_IPAD_PRO_3GEN_11', [[1488, 2266], [1668, 2420], [1668, 2388], [1640, 2360]]);
dimensions('APP_IPAD_105', [[1668, 2224]]);
dimensions('APP_IPAD_97', [[1536, 2008], [1536, 2048], [1496, 2048], [768, 1004], [768, 1024], [748, 1024]]);
dimensions('APP_WATCH_ULTRA', [[422, 514], [410, 502]]);
dimensions('APP_WATCH_SERIES_10', [[416, 496]]);
dimensions('APP_WATCH_SERIES_7', [[396, 484]]);
dimensions('APP_WATCH_SERIES_4', [[368, 448]]);
dimensions('APP_WATCH_SERIES_3', [[312, 390]]);
dimensions('APP_DESKTOP', [[1280, 800], [1440, 900], [2560, 1600], [2880, 1800]]);
dimensions('APP_APPLE_TV', [[1920, 1080], [3840, 2160]]);
dimensions('APP_APPLE_VISION_PRO', [[3840, 2160]]);

function compareNames(left, right) {
  return left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0;
}

function checksum(bytes) {
  return crypto.createHash('md5').update(bytes).digest('hex');
}

export function imageDimensions(bytes) {
  if (bytes.length >= 24
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 8 < bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || offset + 1 >= bytes.length) break;
      if (marker === 0xd8 || marker === 0x01) continue;
      const length = bytes.readUInt16BE(offset);
      if (startOfFrame.has(marker) && offset + 6 < bytes.length) {
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      if (length < 2) break;
      offset += length;
    }
  }
  throw new Error('Could not read PNG or JPEG dimensions');
}

export function inferScreenshotDisplayType(bytes, filePath = 'screenshot') {
  const { width, height } = imageDimensions(bytes);
  const key = width < height ? `${width}x${height}` : `${height}x${width}`;
  const matches = SCREENSHOT_DIMENSIONS.get(key) || [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`${filePath} is ${width}x${height}, which is ambiguous (${matches.join(', ')}); place it in an explicit display-type directory`);
  }
  throw new Error(`${filePath} has unsupported screenshot dimensions ${width}x${height}; place it in an explicit display-type directory if Apple accepts it`);
}

function mediaAsset(entry, fileName, sortKey, bytes) {
  return { path: entry.path, fileName, sortKey, bytes, checksum: checksum(bytes) };
}

export function discoverLocalizedMetadata(entries, metadataRoot = 'AppStore', readBlob) {
  const root = metadataRoot.replace(/\/+$/, '');
  const localizations = {};
  const versionAttributes = {};
  const reviewAttributes = {};
  const emptyLocalization = () => ({
    attributes: {}, appInfoAttributes: {}, screenshots: {}, previews: {},
  });
  const defaultLocalization = emptyLocalization();
  const localization = locale => (localizations[locale] ||= emptyLocalization());
  const readText = sha => readBlob(sha).toString('utf8').replace(/\r?\n$/, '');

  for (const entry of entries) {
    if (entry.path === root) continue;
    const relative = entry.path.slice(root.length + 1);
    const parts = relative.split('/');
    if (parts.length === 1 && entry.type === 'blob' && parts[0] === 'copyright.txt') {
      versionAttributes.copyright = readText(entry.sha);
      continue;
    }
    if (parts.length === 2 && parts[0] === 'review'
      && entry.type === 'blob' && REVIEW_FIELDS[parts[1]]) {
      reviewAttributes[REVIEW_FIELDS[parts[1]]] = readText(entry.sha);
      continue;
    }
    if (parts.length === 1 && entry.type === 'blob' && VERSION_LOCALIZATION_FIELDS[parts[0]]) {
      defaultLocalization.attributes[VERSION_LOCALIZATION_FIELDS[parts[0]]] = readText(entry.sha);
      continue;
    }
    if (parts.length === 1 && entry.type === 'blob' && APP_INFO_LOCALIZATION_FIELDS[parts[0]]) {
      defaultLocalization.appInfoAttributes[APP_INFO_LOCALIZATION_FIELDS[parts[0]]] = readText(entry.sha);
      continue;
    }
    if (parts.length === 2 && entry.type === 'blob' && VERSION_LOCALIZATION_FIELDS[parts[1]]) {
      localization(parts[0]).attributes[VERSION_LOCALIZATION_FIELDS[parts[1]]] = readText(entry.sha);
      continue;
    }
    if (parts.length === 2 && entry.type === 'blob' && APP_INFO_LOCALIZATION_FIELDS[parts[1]]) {
      localization(parts[0]).appInfoAttributes[APP_INFO_LOCALIZATION_FIELDS[parts[1]]] = readText(entry.sha);
      continue;
    }

    const usesDefaultLocale = Boolean(MEDIA[parts[0]]);
    const mediaParts = usesDefaultLocale ? ['<default>', ...parts] : parts;
    const [locale, kind, candidate] = mediaParts;
    if (!locale || !MEDIA[kind] || !candidate || mediaParts.length < 3) continue;
    const sets = (usesDefaultLocale ? defaultLocalization : localization(locale))[kind];
    if (entry.type === 'tree' && mediaParts.length === 3) {
      if (kind === 'screenshots' && !isScreenshotDisplayType(candidate)) {
        throw new Error(`Invalid screenshot display type directory: ${entry.path}`);
      }
      sets[candidate] ||= [];
      continue;
    }
    if (entry.type !== 'blob') continue;
    const fileName = parts.at(-1);
    if (fileName.startsWith('.')) continue;
    const extension = path.posix.extname(fileName).toLowerCase();
    if (!MEDIA[kind].extensions.has(extension)) {
      throw new Error(`Unsupported ${kind} file: ${entry.path}`);
    }
    const bytes = readBlob(entry.sha);
    if (kind === 'screenshots' && mediaParts.length === 3) {
      const displayType = inferScreenshotDisplayType(bytes, entry.path);
      sets[displayType] ||= [];
      sets[displayType].push(mediaAsset(entry, fileName, fileName, bytes));
      continue;
    }
    if (mediaParts.length < 4) {
      throw new Error(`Preview files require an explicit display-type directory: ${entry.path}`);
    }
    if (kind === 'screenshots' && !isScreenshotDisplayType(candidate)) {
      throw new Error(`Invalid screenshot display type directory: ${entry.path}`);
    }
    sets[candidate] ||= [];
    sets[candidate].push(mediaAsset(entry, fileName, mediaParts.slice(2).join('/'), bytes));
  }

  for (const value of [defaultLocalization, ...Object.values(localizations)]) {
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
  return { versionAttributes, reviewAttributes, defaultLocalization, localizations };
}

function hasLocalizedChanges(value) {
  return Object.keys(value.attributes).length > 0
    || Object.keys(value.appInfoAttributes).length > 0
    || Object.keys(value.screenshots).length > 0
    || Object.keys(value.previews).length > 0;
}

async function resolveDefaultLocalization(asc, metadata) {
  if (!hasLocalizedChanges(metadata.defaultLocalization)) return metadata.localizations;
  const locale = await asc.getAppPrimaryLocale();
  const explicit = metadata.localizations[locale] || {
    attributes: {}, appInfoAttributes: {}, screenshots: {}, previews: {},
  };
  return {
    ...metadata.localizations,
    [locale]: {
      attributes: { ...metadata.defaultLocalization.attributes, ...explicit.attributes },
      appInfoAttributes: {
        ...metadata.defaultLocalization.appInfoAttributes,
        ...explicit.appInfoAttributes,
      },
      screenshots: { ...metadata.defaultLocalization.screenshots, ...explicit.screenshots },
      previews: { ...metadata.defaultLocalization.previews, ...explicit.previews },
    },
  };
}

async function syncAppInfoMetadata(asc, localizations, dryRun) {
  const managed = Object.entries(localizations).filter(([, value]) => (
    Object.keys(value.appInfoAttributes).length > 0
  ));
  if (managed.length === 0) return;

  const appInfo = await asc.getEditableAppInfo();
  if (!appInfo) throw new Error('App Store Connect did not return an editable App Info resource');
  const existing = await asc.getAppInfoLocalizations(appInfo.id);
  const byLocale = new Map(existing.map(item => [item.attributes?.locale, item]));

  for (const [locale, value] of managed) {
    const target = byLocale.get(locale);
    if (!target && !Object.hasOwn(value.appInfoAttributes, 'name')) {
      throw new Error(`Creating App Info localization ${locale} requires ${locale}/name.txt`);
    }
    if (dryRun) {
      log(`[DRY RUN] Would ${target ? 'update' : 'create'} localized App Info for ${locale}`);
    } else if (target) {
      await asc.updateAppInfoLocalization(target.id, value.appInfoAttributes);
      log(`Updated localized App Info for ${locale}`);
    } else {
      await asc.createAppInfoLocalization(appInfo.id, locale, value.appInfoAttributes);
      log(`Created localized App Info for ${locale}`);
    }
  }
}

async function syncReviewMetadata(asc, versionId, attributes, dryRun) {
  if (Object.keys(attributes).length === 0) return;
  const reviewAttributes = { ...attributes };
  const existing = await asc.getAppStoreReviewDetail(versionId);
  const managesCredentials = Object.hasOwn(reviewAttributes, 'demoAccountName')
    || Object.hasOwn(reviewAttributes, 'demoAccountPassword');
  if (managesCredentials) {
    const managesBothCredentials = Object.hasOwn(reviewAttributes, 'demoAccountName')
      && Object.hasOwn(reviewAttributes, 'demoAccountPassword');
    const suppliesCredential = Boolean(
      reviewAttributes.demoAccountName || reviewAttributes.demoAccountPassword
    );
    if (managesBothCredentials || suppliesCredential) {
      reviewAttributes.demoAccountRequired = suppliesCredential;
    }
  }
  if (!existing) {
    const required = ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail'];
    const missing = required.filter(field => !reviewAttributes[field]);
    if (missing.length > 0) {
      throw new Error(`Creating App Review information requires: ${missing.join(', ')}`);
    }
    if (!Object.hasOwn(reviewAttributes, 'demoAccountRequired')) {
      reviewAttributes.demoAccountRequired = false;
    }
  }
  if (dryRun) {
    log(`[DRY RUN] Would ${existing ? 'update' : 'create'} App Review information`);
    return;
  }
  if (existing) {
    await asc.updateAppStoreReviewDetail(existing.id, reviewAttributes);
    log('Updated App Review information');
  } else {
    await asc.createAppStoreReviewDetail(versionId, reviewAttributes);
    log('Created App Review information');
  }
}

export async function syncLocalizedMetadata(asc, github, {
  metadataPath,
  ref,
  versionId,
  dryRun = false,
} = {}) {
  if (!metadataPath) return { enabled: false, managedWhatsNewLocales: new Set() };

  const entries = github.getRepositoryTree(metadataPath, ref);
  const root = metadataPath.replace(/\/+$/, '');
  const rootEntry = entries.find(entry => entry.path === root);
  if (!rootEntry) {
    throw new Error(`Metadata directory ${root} does not exist at ${ref}`);
  }
  if (rootEntry.type !== 'tree') {
    throw new Error(`Metadata path ${root} is not a directory at ${ref}`);
  }
  const metadata = discoverLocalizedMetadata(
    entries,
    metadataPath,
    sha => github.getRepositoryBlob(sha),
  );
  const localizations = await resolveDefaultLocalization(asc, metadata);
  const managedWhatsNewLocales = new Set();
  await syncAppInfoMetadata(asc, localizations, dryRun);
  if (Object.keys(metadata.versionAttributes).length > 0) {
    if (dryRun) log('[DRY RUN] Would update App Store version metadata');
    else {
      await asc.updateAppStoreVersion(versionId, metadata.versionAttributes);
      log('Updated App Store version metadata');
    }
  }
  await syncReviewMetadata(asc, versionId, metadata.reviewAttributes, dryRun);

  const hasLocalizedVersionMetadata = Object.values(localizations).some(value => (
    Object.keys(value.attributes).length > 0
      || Object.keys(value.screenshots).length > 0
      || Object.keys(value.previews).length > 0
  ));
  const existingLocalizations = hasLocalizedVersionMetadata
    ? await asc.getAppStoreVersionLocalizations(versionId)
    : [];
  const localizationsByLocale = new Map(existingLocalizations.map(item => [
    item.attributes?.locale,
    item,
  ]));

  for (const [locale, value] of Object.entries(localizations)) {
    if (Object.hasOwn(value.attributes, 'whatsNew')) managedWhatsNewLocales.add(locale);
    const screenshotSets = Object.entries(value.screenshots);
    const previewSets = Object.entries(value.previews);
    const hasChanges = Object.keys(value.attributes).length > 0
      || screenshotSets.length > 0
      || previewSets.length > 0;
    if (!hasChanges) continue;

    let target = localizationsByLocale.get(locale) || null;
    if (!target && dryRun) {
      log(`[DRY RUN] Would create App Store localization ${locale}`);
      continue;
    }
    if (!target) {
      target = await asc.createAppStoreVersionLocalization(versionId, locale);
      localizationsByLocale.set(locale, target);
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
