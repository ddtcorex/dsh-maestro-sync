// @vitest-environment jsdom
/**
 * Redesigned Sync UI (Task: sync settings redesign): everything lives inside the
 * settings card — connection banner, paged file lists (Only here / Only there)
 * and the confirmation-first Preview/Apply dialog. The dialog contract itself
 * stays covered by client.spec.tsx; this spec pins the card's file lists:
 * both buckets render with cursor pagination and Show more.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { SyncPanel } from '../src/client/index.js';

const PREVIEW_ID = 'b'.repeat(32);
const summary = { copied: 1, merged: 1, skipped: 2, conflicts: 0, added: 1 };

function makeCtx(rpc: any) {
  return { connection: { rpc: { call: rpc } }, get: () => undefined as any };
}

function statusRpc() {
  return vi.fn(async (_ch: string, method: string, args: any) => {
    if (method === 'status' && !args?.bucket) {
      return { ok: true, remoteHost: 'sync-host', connection: { ok: true, host: 'sync-host' }, localOnly: 2, remoteOnly: 1, both: 3 };
    }
    if (method === 'status') {
      const bucketFiles =
        args?.bucket === 'localOnly'
          ? ['memories/daily/2026-08-29.md', 'memories/MEMORY.md']
          : ['sessions/abc123/xyz.jsonl.zstd'];
      return { ok: true, total: bucketFiles.length, offset: args?.cursor ?? 0, limit: 10, files: bucketFiles, nextCursor: null, connection: { ok: true, host: 'sync-host' }, remoteHost: 'sync-host' };
    }
    if (method === 'preview') {
      return {
        ok: true,
        previewId: PREVIEW_ID,
        revision: 'rev1',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        actions: [{ path: 'memories/MEMORY.md', action: 'merge', target: 'local', added: 1, reason: 'content differs' }],
        summary,
        connection: { ok: true, host: 'sync-host' },
        remoteHost: 'sync-host',
      };
    }
    return { ok: true };
  });
}

beforeEach(() => cleanup());

describe('SyncPanel file lists', () => {
  it('renders both bucket tables from status pages and pages them with Show more', async () => {
    const rpc = vi.fn(async (_ch: string, method: string, args: any) => {
      if (method === 'status' && !args?.bucket) {
        return { ok: true, remoteHost: 'sync-host', connection: { ok: true, host: 'sync-host' }, localOnly: 2, remoteOnly: 12, both: 3 };
      }
      if (method === 'status') {
        if (args?.bucket === 'localOnly') {
          return { ok: true, total: 2, offset: args?.cursor ?? 0, limit: 10, files: ['memories/daily/2026-08-29.md', 'memories/MEMORY.md'], nextCursor: null, connection: { ok: true, host: 'sync-host' }, remoteHost: 'sync-host' };
        }
        const start = args?.cursor ?? 0;
        const files = Array.from({ length: 12 }, (_, i) => `memories/daily/2026-08-${String(i + 1).padStart(2, '0')}.md`).slice(start, start + 10);
        return { ok: true, total: 12, offset: start, limit: 10, files, nextCursor: start + 10 < 12 ? start + 10 : null, connection: { ok: true, host: 'sync-host' }, remoteHost: 'sync-host' };
      }
      return { ok: true };
    });
    render(React.createElement(SyncPanel, { ctx: makeCtx(rpc) }));

    await waitFor(() => expect(screen.getAllByText('Coming from the other machine').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Ready to send').length).toBeGreaterThan(0);
    // local list loads its files
    await waitFor(() => expect(screen.getByText(/2026-08-29\.md/)).toBeInTheDocument());
    // remote list shows the first page (10) with a Show more footer
    await waitFor(() => expect(screen.getByText(/2026-08-01\.md/)).toBeInTheDocument());
    expect(document.querySelectorAll('[data-sync-file]').length).toBeGreaterThan(10);
    const more = screen.getAllByRole('button', { name: /show more/i });
    expect(more.length).toBeGreaterThan(0);
    fireEvent.click(more[0]!);
    await waitFor(() => expect(screen.getByText(/2026-08-11\.md/)).toBeInTheDocument());
  });

  it('opens the confirmation dialog from a preview inside the card', async () => {
    const rpc = statusRpc();
    render(React.createElement(SyncPanel, { ctx: makeCtx(rpc) }));
    await waitFor(() => expect(screen.getByTestId('sync-preview-pull')).toBeEnabled());
    fireEvent.click(screen.getByTestId('sync-preview-pull'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('MEMORY.md');
    expect(dialog.textContent).toMatch(/1 new entry/);
    const applyCalls = rpc.mock.calls.filter(([, m]: any) => m === 'apply');
    expect(applyCalls.length).toBe(0);
  });

  it('shows the shared Maestro logo in the card header', async () => {
    const rpc = statusRpc();
    render(React.createElement(SyncPanel, { ctx: makeCtx(rpc) }));
    await waitFor(() => expect(screen.getByText('Maestro Sync')).toBeInTheDocument());
    expect(document.querySelector('[data-maestro-logo]')).not.toBeNull();
  });
});