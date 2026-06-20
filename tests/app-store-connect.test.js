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

function createASCWithRequest(requestImpl) {
  const asc = new AppStoreConnectAPI('key', 'issuer', Buffer.from('fake-key').toString('base64'));
  asc.getAppId = async () => 'app-1';
  asc.request = requestImpl;
  return asc;
}

test('clearBlockingReviewSubmissions deletes empty drafts and cancels open submissions', async () => {
  const calls = [];
  const asc = createASCWithRequest(async (endpoint, options = {}) => {
    const method = options.method || 'GET';
    calls.push(`${method} ${endpoint.split('?')[0]}`);
    if (method === 'GET' && endpoint.startsWith('/reviewSubmissions')) {
      return {
        data: [
          { id: 'complete-1', attributes: { state: 'COMPLETE' }, relationships: { items: { data: [{ id: 'i0' }] } } },
          { id: 'empty-draft', attributes: { state: 'READY_FOR_REVIEW' }, relationships: { items: { data: [] } } },
          { id: 'unresolved', attributes: { state: 'UNRESOLVED_ISSUES' }, relationships: { items: { data: [{ id: 'i1' }] } } },
        ],
      };
    }
    return null; // DELETE / PATCH responses
  });

  const cleared = await asc.clearBlockingReviewSubmissions();

  assert.deepEqual(cleared, [
    { id: 'empty-draft', state: 'READY_FOR_REVIEW', action: 'deleted' },
    { id: 'unresolved', state: 'UNRESOLVED_ISSUES', action: 'canceled' },
  ]);
  assert.ok(calls.includes('DELETE /reviewSubmissions/empty-draft'));
  assert.ok(calls.includes('PATCH /reviewSubmissions/unresolved'));
  // COMPLETE submissions never block and must be left alone.
  assert.ok(!calls.some(c => c.includes('complete-1')));
});

test('clearBlockingReviewSubmissions skips the exceptId submission', async () => {
  const calls = [];
  const asc = createASCWithRequest(async (endpoint, options = {}) => {
    const method = options.method || 'GET';
    calls.push(`${method} ${endpoint.split('?')[0]}`);
    if (method === 'GET') {
      return {
        data: [
          { id: 'keep', attributes: { state: 'READY_FOR_REVIEW' }, relationships: { items: { data: [] } } },
        ],
      };
    }
    return null;
  });

  const cleared = await asc.clearBlockingReviewSubmissions('keep');

  assert.deepEqual(cleared, []);
  assert.ok(!calls.some(c => c.startsWith('DELETE') || c.startsWith('PATCH')));
});

test('getOrCreateDraftReviewSubmission rolls back the submission when item creation fails', async () => {
  const calls = [];
  const asc = createASCWithRequest(async (endpoint, options = {}) => {
    const method = options.method || 'GET';
    calls.push(`${method} ${endpoint.split('?')[0]}`);
    if (method === 'POST' && endpoint === '/reviewSubmissions') {
      return { data: { id: 'new-sub' } };
    }
    if (method === 'POST' && endpoint === '/reviewSubmissionItems') {
      throw new Error('API Error 409: This resource cannot be reviewed');
    }
    return null; // DELETE response
  });
  // No existing submission for this version.
  asc.getReviewSubmissionIdForVersion = async () => null;

  await assert.rejects(() => asc.getOrCreateDraftReviewSubmission('version-1'), /409/);
  assert.ok(
    calls.includes('DELETE /reviewSubmissions/new-sub'),
    'should delete the half-created empty submission'
  );
});
