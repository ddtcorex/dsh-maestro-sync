// tests/backup-config.spec.ts — backup target config + secret resolution (redacted).
import { describe, it, expect } from 'vitest';
import { describeSecretSource, resolveBackupTarget, type BackupSecrets } from '../src/host/backup-config.js';

describe('backup config', () => {
  it('describeSecretSource never leaks values: env|file|none', () => {
    expect(describeSecretSource({ R2_ACCESS_KEY_ID: 'x', R2_SECRET_ACCESS_KEY: 'y' }, '/nope')).toBe('env');
    expect(describeSecretSource({ AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y' }, '/nope')).toBe('env');
    expect(describeSecretSource({}, '/nope')).toBe('none');
  });

  it('resolveBackupTarget builds an R2 target with a default endpoint+prefix and env secrets', async () => {
    const t = await resolveBackupTarget(
      { domains: { sync: { r2: { accountId: 'acct', bucket: 'maestro-backup' } } } },
      { R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk' } as any,
    );
    expect(t.config.provider).toBe('r2');
    expect(t.config.endpoint).toContain('acct');
    expect(t.config.prefix).toMatch(/^v1\/hosts\/[0-9a-f]{12}\/$/);
    expect(t.secrets.accessKeyId).toBe('ak');
    expect(t.source).toBe('env');
  });

  it('resolves R2 secrets from the private sidecar when env is absent', async () => {
    const t = await resolveBackupTarget(
      { domains: { sync: { r2: { accountId: 'acct', bucket: 'b' } } } },
      {},
      // sidecar path override: write a temp file and pass its dir
      (() => {
        const tmp = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'bkcfg-'));
        require('node:fs').writeFileSync(require('node:path').join(tmp, 'dsh-maestro-sync', 'backup-secrets.json'), JSON.stringify({ accessKeyId: 'file-ak', secretAccessKey: 'file-sk' }), 'utf-8');
        return tmp;
      })(),
    );
    expect(t.source).toBe('file');
    expect(t.secrets.accessKeyId).toBe('file-ak');
  });

  it('throws MISSING_BACKUP_SECRETS when no secret source resolves', async () => {
    await expect(resolveBackupTarget({ domains: { sync: { r2: { accountId: 'acct', bucket: 'b' } } } }, {} as any)).rejects.toMatchObject({ code: 'MISSING_BACKUP_SECRETS' });
  });

  it('aws provider resolves from the same config shape (UI hidden phase 1)', async () => {
    const t = await resolveBackupTarget(
      { domains: { sync: { r2: { provider: 'aws', bucket: 'maestro-backup', region: 'eu-west-1' } } } },
      { AWS_ACCESS_KEY_ID: 'ak', AWS_SECRET_ACCESS_KEY: 'sk' } as any,
    );
    expect(t.config.provider).toBe('aws');
    expect(t.config.region).toBe('eu-west-1');
  });

  it('never returns secrets on the status path: only the source label and config', async () => {
    const t = await resolveBackupTarget({ domains: { sync: { r2: { accountId: 'acct', bucket: 'b' } } } }, { R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk' } as any);
    const status = JSON.stringify({ source: t.source, bucket: t.config.bucket, prefix: t.config.prefix, provider: t.config.provider, endpoint: t.config.endpoint });
    expect(status).not.toContain('ak');
    expect(status).not.toContain('sk');
    expect(status).not.toContain('secret');
  });
});