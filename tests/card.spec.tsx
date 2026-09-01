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

const carrier = (value: any) => ({ ok: true, value });

function statusRpc() {
  return vi.fn(async (_ch: string, method: string, args: any) => {
    if (method === 'status' && !args?.bucket) {
      return carrier({ ok: true, remoteHost: 'sync-host', connection: { ok: true, host: 'sync-host' }, localOnly: 2, remoteOnly: 1, both: 3 });
    }
    if (method === 'status') {
      const bucketFiles =
        args?.bucket === 'localOnly'
          ? ['memories/daily/2026-08-29.md', 'memories/MEMORY.md']
          : ['sessions/abc123/xyz.jsonl.zstd'];
      return carrier({ ok: true, total: bucketFiles.length, offset: args?.cursor ?? 0, limit: 10, files: bucketFiles, nextCursor: null, connection: { ok: true, host: 'sync-host' }, remoteHost: 'sync-host' });
    }
    if (method === 'previewStart') {
      return carrier({ jobId: 'job1' });
    }
    if (method === 'previewStatus') {
      return carrier({
        status: 'done',
        preview: {
          ok: true,
          previewId: PREVIEW_ID,
          revision: 'rev1',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          actions: [{ path: 'memories/MEMORY.md', action: 'merge', target: 'local', added: 1, reason: 'content differs' }],
          summary,
          connection: { ok: true, host: 'sync-host' },
          remoteHost: 'sync-host',
        },
      });
    }
    return carrier({ ok: true });
  });
}

beforeEach(() => cleanup());

describe('SyncPanel file lists', () => {
  it('renders both bucket tables from status pages and pages them with Show more', async () => {
    const rpc = vi.fn(async (_ch: string, method: string, args: any) => {
      if (method === 'status' && !args?.bucket) {
        return carrier({ ok: true, remoteHost: 'sync-host', connection: { ok: true, host: 'sync-host' }, localOnly: 2, remoteOnly: 12, both: 3 });
      }
      if (method === 'status') {
        if (args?.bucket === 'localOnly') {
          return carrier({ ok: true, total: 2, offset: args?.cursor ?? 0, limit: 10, files: ['memories/daily/2026-08-29.md', 'memories/MEMORY.md'], nextCursor: null, connection: { ok: true, host: 'sync-host' }, remoteHost: 'sync-host' });
        }
        const start = args?.cursor ?? 0;
        const files = Array.from({ length: 12 }, (_, i) => `memories/daily/2026-08-${String(i + 1).padStart(2, '0')}.md`).slice(start, start + 10);
        return carrier({ ok: true, total: 12, offset: start, limit: 10, files, nextCursor: start + 10 < 12 ? start + 10 : null, connection: { ok: true, host: 'sync-host' }, remoteHost: 'sync-host' });
      }
      return carrier({ ok: true });
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

  it('shows preview progress against a running job, then renders session counts in the dialog', async () => {
    const rpc = vi.fn(async (_ch: string, method: string, args: any) => {
      if (method === 'status' && !args?.bucket) {
        return carrier({ ok: true, remoteHost: 'sync-host', connection: { ok: true, host: 'sync-host' }, localOnly: 2, remoteOnly: 1, both: 3 });
      }
      if (method === 'status') {
        return carrier({ ok: true, total: 0, offset: 0, limit: 10, files: [], nextCursor: null, connection: { ok: true, host: 'sync-host' }, remoteHost: 'sync-host' });
      }
      if (method === 'previewStart') return carrier({ jobId: 'job1' });
      if (method === 'previewStatus') {
        // first poll: running with a session file being counted
        if (!rpc._settled) {
          rpc._settled = true;
          return carrier({ status: 'running', progress: { phase: 'hashing', current: 3, total: 71, file: 'sessions/abc/xyz/session.jsonl.zstd' } });
        }
        return carrier({
          status: 'done',
          preview: {
            ok: true,
            previewId: PREVIEW_ID,
            revision: 'rev1',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            actions: [{ path: 'memories/MEMORY.md', action: 'merge', target: 'local', added: 1, reason: 'content differs' }],
            summary,
            sessionCounts: { added: 5, updated: 12, deleted: 2, identical: 4 },
            connection: { ok: true, host: 'sync-host' },
            remoteHost: 'sync-host',
          },
        });
      }
      return { ok: true };
    });
    render(React.createElement(SyncPanel, { ctx: makeCtx(rpc) }));
    await waitFor(() => expect(screen.getByTestId('sync-preview-pull')).toBeEnabled());
    fireEvent.click(screen.getByTestId('sync-preview-pull'));
    // progress bar appears while the job is hashing sessions
    await waitFor(() => expect(screen.getByTestId('sync-progress')).toBeInTheDocument());
    expect(screen.getByTestId('sync-progress').textContent).toContain('session.jsonl.zstd');
    expect(screen.getByTestId('sync-progress').textContent).toMatch(/3\/71/);
    // once settled, the dialog summarises sessions (5 added · 12 updated · 2 deleted · 4 identical)
    const dialog = await screen.findByRole('dialog');
    const counts = dialog.querySelector('[data-sync-sessioncounts]');
    expect(counts).not.toBeNull();
    expect(counts!.textContent).toContain('5 added');
    expect(counts!.textContent).toContain('12 updated');
    expect(counts!.textContent).toContain('2 deleted');
    expect(counts!.textContent).toContain('4 identical');
    // the memory action still renders as a row
    expect(dialog.querySelectorAll('[data-action-row]').length).toBe(1);
  });

  it('shows the shared Maestro logo in the card header', async () => {
    const rpc = statusRpc();
    render(React.createElement(SyncPanel, { ctx: makeCtx(rpc) }));
    await waitFor(() => expect(screen.getByText('Maestro Sync')).toBeInTheDocument());
    expect(document.querySelector('[data-maestro-logo]')).not.toBeNull();
  });
});