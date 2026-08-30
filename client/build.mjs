// Re-export: keep Task 6 contract (client/build.mjs) while canonical build lives in scripts/
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = resolve(root, 'scripts/build-client.mjs')
const child = spawn(process.execPath, [script], { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
