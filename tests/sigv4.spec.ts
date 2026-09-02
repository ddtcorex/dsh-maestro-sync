// tests/sigv4.spec.ts — pins SigV4 determinism against the AWS documentation
// GET-object example (exact signature from the official docs).
import { describe, it, expect } from 'vitest';
import { signRequest } from '../src/host/sigv4.js';

describe('sigv4', () => {
  it('reproduces the AWS docs GET-object example signature', () => {
    const bodySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // empty payload
    const got = signRequest({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      headers: {
        'range': 'bytes=0-9',
        'x-amz-content-sha256': bodySha,
        'x-amz-date': '20130524T000000Z',
      },
      bodySha256: bodySha,
      region: 'us-east-1',
      service: 's3',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(got.amzDate).toBe('20130524T000000Z');
    expect(got.xAmzContentSha256).toBe(bodySha);
    expect(got.authorization).toContain(
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});