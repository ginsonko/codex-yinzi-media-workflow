'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { signRequest } = require('../src/services/volcRequestSigner');

describe('Volcengine request signer', () => {
  it('matches the official SDK fixed signing vector', () => {
    const request = {
      region: 'cn-beijing',
      method: 'POST',
      pathname: '/api/v3',
      params: { Version: '2024-01-01', Action: 'ListAssets', ProjectName: 'demo-project' },
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ AssetGroupId: 'group-demo' }),
    };

    signRequest(request, 'ark', {
      accessKeyId: 'test-access-key',
      secretKey: 'test-secret-key',
      sessionToken: 'test-session-token',
    }, new Date('2026-08-12T00:00:00.000Z'));

    assert.deepEqual(request.params, {
      Action: 'ListAssets',
      ProjectName: 'demo-project',
      Version: '2024-01-01',
    });
    assert.equal(request.headers['X-Date'], '20260812T000000Z');
    assert.equal(request.headers['X-Security-Token'], 'test-session-token');
    assert.equal(request.headers['X-Content-Sha256'], 'a4c6c5a24defa012a16667ad13054d906d33bcd597662bec72b25be7eaababfe');
    assert.equal(
      request.headers.Authorization,
      'HMAC-SHA256 Credential=test-access-key/20260812/cn-beijing/ark/request, SignedHeaders=x-content-sha256;x-date;x-security-token, Signature=59caabf52dfae7cb044a418506bf5ae5cfd970bf8a11d2feb641bd4b9a895782'
    );
  });
});
