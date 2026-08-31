import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
describe('manifest', () => {
  it('has private:false and correct main', () => {
    const j = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(j.private).toBe(false);
    expect(j.main).toBe('./lib/index.js');
    expect(j.files).toContain('lib');
  });
  it('exports the DSH client bundle', () => {
    const j = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(j.exports['./client']).toEqual({
      types: './lib/types/client/index.d.ts',
      default: './lib/client.js',
    });
  });
  it('pnpm-workspace allows esbuild', () => {
    const y = readFileSync('pnpm-workspace.yaml', 'utf-8');
    expect(y).toMatch(/allowBuilds/);
    expect(y).toMatch(/esbuild:\s*true/);
  });
  it('cordis patch has correct channel', () => {
    const y = readFileSync('cordis.patch.yml', 'utf-8');
    expect(y).toMatch(/id:\s*dsh-maestro-sync/);
    expect(y).toMatch(/channel:\s*\/dsh-maestro-sync/);
  });
});
