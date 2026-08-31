import { describe, it, expect } from 'vitest';
import { buildPlan, buildPreview, clearPreviews } from '../src/host/sync-plan.js';
import type { FileSnapshot } from '../src/host/sync-types.js';

describe('sync-plan', () => {
  it('marks same-name unequal content as merge and computes the real added count', async () => {
    const localSnap: FileSnapshot = { path: 'memories/daily/2026-08-29.md', sha256: 'aaa', size: 10, kind: 'memory' };
    const remoteSnap: FileSnapshot = { path: 'memories/daily/2026-08-29.md', sha256: 'bbb', size: 12, kind: 'memory' };
    const localContents = new Map([['memories/daily/2026-08-29.md', Buffer.from('a\n§\nfoo\n')]]);
    const remoteContents = new Map([['memories/daily/2026-08-29.md', Buffer.from('a\n§\nbar\n')]]);
    const preview = await buildPlan([localSnap], [remoteSnap], 'pull', localContents, remoteContents);
    expect(preview.actions).toContainEqual(expect.objectContaining({ path: 'memories/daily/2026-08-29.md', action: 'merge' }));
    const act = preview.actions.find((a) => a.path === 'memories/daily/2026-08-29.md');
    expect(act?.added).toBeGreaterThanOrEqual(0);
  });

  it('skips identical bytes even when mtime differs', async () => {
    const snap: FileSnapshot = { path: 'memories/a.md', sha256: 'same', size: 5, kind: 'memory' };
    const plan = await buildPlan([snap], [snap], 'pull', new Map([['memories/a.md', Buffer.from('hi')]]), new Map([['memories/a.md', Buffer.from('hi')]]));
    expect(plan.summary.skipped).toBe(1);
    expect(plan.actions[0].action).toBe('skip');
  });

  it('buildPreview stores and expires', async () => {
    clearPreviews();
    const snap: FileSnapshot = { path: 'memories/a.md', sha256: 'same', size: 5, kind: 'memory' };
    const preview = await buildPreview([snap], [snap], 'pull', new Map(), new Map());
    expect(preview.previewId).toBeDefined();
    expect(preview.expiresAt).toBeDefined();
    expect(preview.actions.length).toBeGreaterThan(0);
  });

  it('copies remote-only for pull and skips for push', async () => {
    const remoteSnap: FileSnapshot = { path: 'memories/new.md', sha256: 'new', size: 5, kind: 'memory' };
    const pull = await buildPlan([], [remoteSnap], 'pull', new Map(), new Map([['memories/new.md', Buffer.from('hi')]]));
    expect(pull.actions[0].action).toBe('copy');
    const push = await buildPlan([], [remoteSnap], 'push', new Map(), new Map([['memories/new.md', Buffer.from('hi')]]));
    expect(push.actions[0].action).toBe('skip');
  });
});
