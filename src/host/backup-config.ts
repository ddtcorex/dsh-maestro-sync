// src/host/backup-config.ts — backup target config + secret resolution.
//
// Non-secret config comes from the shared settings store (domains.sync.r2.*);
// secret material never lives in settings, never is logged, and never crosses
// RPC/tools — resolution order: environment first, then a private 0600 sidecar
// in the plugin's own runtime directory (outside the eligible data boundary,
// so the merge CLI never reads or syncs it). Status surfaces only the source
// label, the bucket, the prefix and the provider.
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { load } from '@ddtcorex/dsh-maestro-config-lib';

export interface BackupProviderConfig {
  provider: 'r2' | 'aws';
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
}

export interface BackupSecrets {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface BackupTarget {
  provider: 'r2' | 'aws';
  bucket: string;
  prefix: string;
  hostId: string;
}

export type SecretSource = 'env' | 'file' | 'none';

export const BACKUP_SIDECAR_REL = 'dsh-maestro-sync/backup-secrets.json';

export function describeSecretSource(env: Record<string, string | undefined>, sidecarPath: string): SecretSource {
  if ((env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) || (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)) return 'env';
  try {
    if (nodeFs.existsSync(sidecarPath)) return 'file';
  } catch {}
  return 'none';
}

export async function resolveBackupTarget(
  doc: { domains?: { sync?: { r2?: Record<string, unknown> } } } = {},
  env: Record<string, string | undefined> = process.env as any,
  dshHome: string = process.env.DSH_HOME || nodePath.join(os.homedir(), '.dsh'),
): Promise<{ config: BackupProviderConfig; secrets: BackupSecrets; source: SecretSource }> {
  const sync = doc.domains?.sync as Record<string, any> | undefined;
  const r2 = (sync?.r2 ?? {}) as Record<string, any>;
  const provider = (r2.provider as string | undefined) === 'aws' ? 'aws' : 'r2';
  const accountId = (r2.accountId as string | undefined) ?? '';
  const bucket = (r2.bucket as string | undefined) ?? 'maestro-backup';
  const hostId = createHash('sha256').update(os.hostname()).digest('hex').slice(0, 12);
  const prefix = (r2.prefix as string | undefined) ?? `v1/hosts/${hostId}/`;
  const region = (r2.region as string | undefined) ?? (provider === 'r2' ? 'auto' : '');
  const endpoint = (r2.endpoint as string | undefined) ?? (provider === 'r2' ? `https://${accountId}.r2.cloudflarestorage.com` : '');

  const sidecar = nodePath.join(dshHome, BACKUP_SIDECAR_REL);
  let secrets: BackupSecrets | null = null;
  let source: SecretSource = 'none';
  if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
    secrets = { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY };
    source = 'env';
  } else if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    secrets = { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY };
    source = 'env';
  } else {
    try {
      const raw = nodeFs.readFileSync(sidecar, 'utf-8') as string;
      const parsed = JSON.parse(raw) as { accessKeyId?: string; secretAccessKey?: string };
      if (parsed.accessKeyId && parsed.secretAccessKey) {
        secrets = { accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey };
        source = 'file';
      }
    } catch {}
  }
  if (!secrets) {
    throw Object.assign(new Error('backup requires access key secret material (environment or private sidecar)'), {
      phase: 'validate',
      code: 'MISSING_BACKUP_SECRETS',
    });
  }
  return { config: { provider, endpoint, region, bucket, prefix }, secrets, source };
}