'use strict';

const crypto = require('crypto');

const ALGORITHM = 'HMAC-SHA256';
const DATE_HEADER = 'X-Date';
const TOKEN_HEADER = 'X-Security-Token';
const CONTENT_SHA256_HEADER = 'X-Content-Sha256';
const UNSIGNABLE_HEADERS = new Set([
  'authorization',
  'content-type',
  'content-length',
  'user-agent',
  'presigned-expires',
  'expect',
]);

function uriEscape(value) {
  return encodeURIComponent(String(value))
    .replace(/[^A-Za-z0-9_.~%\-]+/g, escape)
    .replace(/[*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sortParams(params = {}) {
  return Object.fromEntries(Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => [key, params[key]]));
}

function queryParamsToString(params = {}) {
  return Object.entries(sortParams(params)).map(([key, value]) => {
    const escapedKey = uriEscape(key);
    if (Array.isArray(value)) {
      return `${escapedKey}=${value.map(uriEscape).sort().join(`&${escapedKey}=`)}`;
    }
    return `${escapedKey}=${uriEscape(value)}`;
  }).join('&');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function signRequest(request, serviceName, credentials, date = new Date()) {
  const datetime = date.toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const datePart = datetime.slice(0, 8);
  const region = request.region;
  const service = serviceName || 'ark';
  const headers = request.headers || (request.headers = {});
  request.params = sortParams(request.params);

  headers[DATE_HEADER] = datetime;
  if (credentials.sessionToken) headers[TOKEN_HEADER] = credentials.sessionToken;
  if (request.body) {
    const body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    headers[CONTENT_SHA256_HEADER] = sha256(body);
  }

  const signedHeaderEntries = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value])
    .filter(([key]) => !UNSIGNABLE_HEADERS.has(key))
    .sort(([left], [right]) => left.localeCompare(right));
  const signedHeaders = signedHeaderEntries.map(([key]) => key).join(';');
  const canonicalHeaders = signedHeaderEntries
    .map(([key, value]) => `${key}:${String(value).replace(/\s+/g, ' ').trim()}`)
    .join('\n');
  const bodyHash = headers[CONTENT_SHA256_HEADER] || sha256('');
  const canonicalRequest = [
    String(request.method || 'GET').toUpperCase(),
    request.pathname || '/',
    queryParamsToString(request.params),
    `${canonicalHeaders}\n`,
    signedHeaders,
    bodyHash,
  ].join('\n');
  const scope = `${datePart}/${region}/${service}/request`;
  const stringToSign = [ALGORITHM, datetime, scope, sha256(canonicalRequest)].join('\n');
  const dateKey = hmac(credentials.secretKey, datePart);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, 'request');
  const signature = hmac(signingKey, stringToSign, 'hex');

  headers.Authorization = `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return request;
}

module.exports = { queryParamsToString, signRequest };
