import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/log.ts';

test('log redaction strips bot tokens, bearer tokens, session cookies, project keys and named secrets', () => {
  const samples = [
    'https://api.telegram.org/bot123456789:AAEhBOweik9ai2o-x_y_zABCDEFGHIJKLMNOP/getUpdates',
    'authorization: Bearer abc.def-ghi',
    'cookie=qsb_session=XYZ123; path=/',
    '{"token":"s3cret","ok":1}',
    'key qsb_abcdefghijklmnopqrstuvwxyz012345 used',
    'password=hunter2&x=1',
  ];
  const output = samples.map(redact).join('\n');
  for (const secret of [
    'AAEhBOweik9ai2o',
    'abc.def-ghi',
    'XYZ123',
    's3cret',
    'abcdefghijklmnopqrstuvwxyz012345',
    'hunter2',
  ])
    assert.ok(!output.includes(secret), `${secret} leaked: ${output}`);
  assert.match(output, /api\.telegram\.org\/bot<redacted>\/getUpdates/);
  assert.match(output, /"ok":1/);
});
