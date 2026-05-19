import test from 'node:test';
import assert from 'node:assert/strict';

import { AppStoreConnectAPI } from '../lib/app-store-connect.js';

function createASCWithVersions(versions) {
  const asc = new AppStoreConnectAPI('key', 'issuer', Buffer.from('fake-key').toString('base64'));
  asc.getAppStoreVersions = async () => versions;
  return asc;
}

test('checkRejectedVersion returns the highest rejected build number', async () => {
  const asc = createASCWithVersions({
    data: [
      {
        id: 'version-older',
        type: 'appStoreVersions',
        attributes: {
          versionString: '1.2.3',
          appStoreState: 'REJECTED',
        },
        relationships: {
          build: {
            data: { id: 'build-100' },
          },
        },
      },
      {
        id: 'version-latest',
        type: 'appStoreVersions',
        attributes: {
          versionString: '1.2.4',
          appStoreState: 'DEVELOPER_REJECTED',
        },
        relationships: {
          build: {
            data: { id: 'build-101' },
          },
        },
      },
    ],
    included: [
      {
        id: 'build-100',
        type: 'builds',
        attributes: { version: '100' },
      },
      {
        id: 'build-101',
        type: 'builds',
        attributes: { version: '101' },
      },
    ],
  });

  const rejectedVersion = await asc.checkRejectedVersion();

  assert.deepEqual(rejectedVersion, {
    rejected: true,
    blockReason: 'rejected',
    version: '1.2.4',
    state: 'DEVELOPER_REJECTED',
    buildNumber: '101',
    versionId: 'version-latest',
  });
});

test('checkVersionWithUnresolvedIssues returns the highest build tied to unresolved review issues', async () => {
  const asc = createASCWithVersions({
    data: [
      {
        id: 'version-older',
        type: 'appStoreVersions',
        attributes: {
          versionString: '1.2.3',
          appStoreState: 'PREPARE_FOR_SUBMISSION',
        },
        relationships: {
          build: {
            data: { id: 'build-100' },
          },
        },
      },
      {
        id: 'version-latest',
        type: 'appStoreVersions',
        attributes: {
          versionString: '1.2.4',
          appStoreState: 'PREPARE_FOR_SUBMISSION',
        },
        relationships: {
          build: {
            data: { id: 'build-101' },
          },
        },
      },
    ],
    included: [
      {
        id: 'build-100',
        type: 'builds',
        attributes: { version: '100' },
      },
      {
        id: 'build-101',
        type: 'builds',
        attributes: { version: '101' },
      },
    ],
  });

  asc.getAppId = async () => 'app-1';
  asc.request = async endpoint => {
    assert.match(endpoint, /filter\[state\]=UNRESOLVED_ISSUES/);
    return {
      data: [
        {
          id: 'submission-1',
          relationships: {
            items: {
              data: [{ id: 'item-1' }, { id: 'item-2' }],
            },
          },
        },
      ],
      included: [
        {
          id: 'item-1',
          type: 'reviewSubmissionItems',
          attributes: {
            state: 'UNRESOLVED_ISSUES',
          },
          relationships: {
            appStoreVersion: {
              data: { id: 'version-older' },
            },
          },
        },
        {
          id: 'item-2',
          type: 'reviewSubmissionItems',
          attributes: {
            state: 'UNRESOLVED_ISSUES',
          },
          relationships: {
            appStoreVersion: {
              data: { id: 'version-latest' },
            },
          },
        },
      ],
    };
  };

  const unresolvedVersion = await asc.checkVersionWithUnresolvedIssues();

  assert.deepEqual(unresolvedVersion, {
    hasUnresolvedIssues: true,
    blockReason: 'unresolved_review',
    version: '1.2.4',
    state: 'PREPARE_FOR_SUBMISSION',
    buildNumber: '101',
    versionId: 'version-latest',
  });
});

test('checkVersionWithUnresolvedIssues ignores non-unresolved items in the same submission', async () => {
  const asc = createASCWithVersions({
    data: [
      {
        id: 'version-unresolved',
        type: 'appStoreVersions',
        attributes: {
          versionString: '1.2.3',
          appStoreState: 'PREPARE_FOR_SUBMISSION',
        },
        relationships: {
          build: {
            data: { id: 'build-100' },
          },
        },
      },
      {
        id: 'version-ready',
        type: 'appStoreVersions',
        attributes: {
          versionString: '1.2.4',
          appStoreState: 'PREPARE_FOR_SUBMISSION',
        },
        relationships: {
          build: {
            data: { id: 'build-101' },
          },
        },
      },
    ],
    included: [
      {
        id: 'build-100',
        type: 'builds',
        attributes: { version: '100' },
      },
      {
        id: 'build-101',
        type: 'builds',
        attributes: { version: '101' },
      },
    ],
  });

  asc.getAppId = async () => 'app-1';
  asc.request = async () => ({
    data: [
      {
        id: 'submission-1',
        relationships: {
          items: {
            data: [{ id: 'item-1' }, { id: 'item-2' }],
          },
        },
      },
    ],
    included: [
      {
        id: 'item-1',
        type: 'reviewSubmissionItems',
        attributes: {
          state: 'UNRESOLVED_ISSUES',
        },
        relationships: {
          appStoreVersion: {
            data: { id: 'version-unresolved' },
          },
        },
      },
      {
        id: 'item-2',
        type: 'reviewSubmissionItems',
        attributes: {
          state: 'ACCEPTED',
        },
        relationships: {
          appStoreVersion: {
            data: { id: 'version-ready' },
          },
        },
      },
    ],
  });

  const unresolvedVersion = await asc.checkVersionWithUnresolvedIssues();

  assert.deepEqual(unresolvedVersion, {
    hasUnresolvedIssues: true,
    blockReason: 'unresolved_review',
    version: '1.2.3',
    state: 'PREPARE_FOR_SUBMISSION',
    buildNumber: '100',
    versionId: 'version-unresolved',
  });
});
