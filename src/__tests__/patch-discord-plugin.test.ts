// scripts/patch-discord-plugin.py (DCBTN1023): answer buttons on the Discord
// channel plugin's reply tool. Run for real on a copy of the complete 0.0.4
// plugin (fixtures/discord-plugin-0.0.4/server.ts.txt) in a scratch plugins
// cache; the inserted functions are then run with fake discord.js builders.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'patch-discord-plugin.py')
const FIXTURE = join(__dirname, 'fixtures', 'discord-plugin-0.0.4', 'server.ts.txt')
const TAG = 'MARVEEN-PATCH(dcbtn1023)'

let cache = ''
let server = ''

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'dc-plugin-cache-'))
  const dir = join(cache, 'claude-plugins-official', 'discord', '0.0.4')
  mkdirSync(dir, { recursive: true })
  server = join(dir, 'server.ts')
  copyFileSync(FIXTURE, server)
})
afterEach(() => rmSync(cache, { recursive: true, force: true }))

function run(extra: string[] = [], root = cache): { status: number | null; stderr: string } {
  const r = spawnSync('python3', [SCRIPT, ...extra, root], { encoding: 'utf-8', timeout: 30_000 })
  return { status: r.status, stderr: r.stderr }
}

function readState(file: string): { root: string; files: Array<{ version: string; path: string; status: string }> } {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

function syntaxErrors(text: string): string[] {
  const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  return (out.diagnostics ?? []).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

describe('patch-discord-plugin.py', () => {
  it('1st run patches: every added line tagged, buttons inside the reply schema, still parses', () => {
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/patched .*server\.ts \(buttons\)/)
    const text = readFileSync(server, 'utf-8')
    const fixture = readFileSync(FIXTURE, 'utf-8')
    expect(text.split('\n').length - fixture.split('\n').length).toBe(text.split('\n').filter(l => l.endsWith(TAG)).length)
    const reply = text.indexOf("name: 'reply'")
    const field = text.indexOf('buttons: {', reply)
    expect(field).toBeGreaterThan(reply)
    expect(field).toBeLessThan(text.indexOf("required: ['chat_id', 'text'],", reply))
    expect(text.indexOf("name: 'react'")).toBeGreaterThan(field)
    expect(text).toMatch(/const files = \(args\.files as string\[\] \| undefined\) \?\? \[\]\n +const rows = buildButtonRows\(args\.buttons\) \/\/ MARVEEN-PATCH/)
    expect(text).toMatch(/\.\.\.\(i === 0 && files\.length > 0 \? \{ files \} : \{\}\),\n +\.\.\.\(i === chunks\.length - 1 && rows\.length > 0 \? \{ components: rows \} : \{\}\), \/\/ MARVEEN-PATCH/)
    expect(text.indexOf('function clickAllowed(')).toBeLessThan(text.indexOf("client.on('messageCreate'"))
    expect(syntaxErrors(text)).toEqual([])
  })

  it('2nd run is a no-op: `already`, byte-identical, silent', () => {
    const state = join(cache, 'state.json')
    run(['--state', state])
    expect(readState(state).files).toEqual([{ version: '0.0.4', path: server, status: 'patched' }])
    const once = readFileSync(server, 'utf-8')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(readFileSync(server, 'utf-8')).toBe(once)
    expect(readState(state).files).toEqual([{ version: '0.0.4', path: server, status: 'already' }])
  })

  it('taking it back = deleting the tagged lines: byte-identical to the plugin', () => {
    run()
    const back = readFileSync(server, 'utf-8').split('\n').filter(l => !l.endsWith(TAG)).join('\n')
    expect(back).toBe(readFileSync(FIXTURE, 'utf-8'))
  })

  it('all or nothing: one moved anchor (plugin update) leaves the file untouched, loudly, exit 0', () => {
    const changed = readFileSync(FIXTURE, 'utf-8').replace('...(i === 0 && files.length > 0 ? { files } : {}),', '...(i === 0 && files.length ? { files } : {}),')
    writeFileSync(server, changed)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: reply send files option not found exactly once.*the buttons patch left out, the reply tool has no buttons/)
    expect(readFileSync(server, 'utf-8')).toBe(changed)
    expect(readState(state).files[0].status).toBe('anchor-missing:reply send files option')
  })

  it('a plugin whose reply tool already has buttons (upstream took it) is left alone', () => {
    const native = readFileSync(FIXTURE, 'utf-8').replace("        required: ['chat_id', 'text'],", "          buttons: {\n            type: 'array',\n          },\n        required: ['chat_id', 'text'],")
    writeFileSync(server, native)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/already has buttons -- left alone/)
    expect(readFileSync(server, 'utf-8')).toBe(native)
    expect(readState(state).files[0].status).toBe('native')
  })

  it('no plugin cache at all: exit 0, nothing to do', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dc-empty-'))
    try {
      const r = run([], empty)
      expect(r.status).toBe(0)
      expect(r.stderr).toBe('')
    } finally { rmSync(empty, { recursive: true, force: true }) }
  })

  it('an unwritable file: named in the log, exit 0 (the channel still starts)', () => {
    if (process.getuid?.() === 0) return // root writes anyway
    const dir = join(cache, 'claude-plugins-official', 'discord', '0.0.4')
    chmodSync(dir, 0o555)
    try {
      const r = run()
      expect(r.status).toBe(0)
      expect(r.stderr).toMatch(/cannot write .*server\.ts: PermissionError -- left unpatched/)
      expect(readFileSync(server, 'utf-8')).toBe(readFileSync(FIXTURE, 'utf-8'))
    } finally { chmodSync(dir, 0o755) }
  })
})

// The inserted rows builder and click check, run with fake discord.js builders.
type Access = { allowFrom: string[]; groups: Record<string, { requireMention?: boolean; allowFrom?: string[] }> }
function inserted(): {
  buildButtonRows: (raw: unknown) => Array<{ buttons: Array<{ id: string; label: string; style: string }> }>
  clickAllowed: (interaction: unknown, access: Access) => boolean
} {
  run()
  const text = readFileSync(server, 'utf-8')
  const from = text.indexOf('const BUTTON_STYLES')
  const to = text.indexOf('const answeredChoices')
  expect(from).toBeGreaterThan(0)
  expect(to).toBeGreaterThan(from)
  const js = ts.transpileModule(text.slice(from, to), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  class ButtonBuilder {
    id = ''; label = ''; style = ''
    setCustomId(v: string) { this.id = v; return this }
    setLabel(v: string) { this.label = v; return this }
    setStyle(v: string) { this.style = v; return this }
  }
  class ActionRowBuilder {
    buttons: ButtonBuilder[] = []
    addComponents(b: ButtonBuilder[]) { this.buttons.push(...b); return this }
  }
  const ButtonStyle = { Primary: 'P', Secondary: 'S', Success: 'OK', Danger: 'D' }
  return new Function('ButtonBuilder', 'ActionRowBuilder', 'ButtonStyle', `${js}\nreturn { buildButtonRows, clickAllowed }`)(ButtonBuilder, ActionRowBuilder, ButtonStyle)
}

describe('the inserted code', () => {
  it('buttons: 5 per row, choice:<n> ids, default style secondary, nothing when absent', () => {
    const { buildButtonRows } = inserted()
    expect(buildButtonRows(undefined)).toEqual([])
    const rows = buildButtonRows([{ label: 'Igen', style: 'success' }, { label: 'Nem', style: 'danger' }, ...['A', 'B', 'C', 'D', 'E'].map(label => ({ label }))])
    expect(rows.map(r => r.buttons.length)).toEqual([5, 2])
    expect(rows[0].buttons.slice(0, 3)).toEqual([{ id: 'choice:0', label: 'Igen', style: 'OK' }, { id: 'choice:1', label: 'Nem', style: 'D' }, { id: 'choice:2', label: 'A', style: 'S' }])
  })

  it('a bad buttons value throws (a tool error before anything is sent)', () => {
    const { buildButtonRows } = inserted()
    const bad: unknown[] = ['Igen', [{}], [{ label: '  ' }], [{ label: 'x'.repeat(81) }], [{ label: 'A' }, { label: 'A' }], [{ label: 'A', style: 'link' }], Array.from({ length: 26 }, (_, i) => ({ label: `${i}` }))]
    for (const b of bad) expect(() => buildButtonRows(b)).toThrow()
    expect(buildButtonRows([{ label: 'x'.repeat(80) }])).toHaveLength(1)
  })

  it('a click passes the same check as a message', () => {
    const { clickAllowed } = inserted()
    const owner = '1', other = '2'
    const access: Access = {
      allowFrom: [owner],
      groups: { mention: {}, open: { requireMention: false, allowFrom: [] }, team: { requireMention: false, allowFrom: [other] } },
    }
    const click = (user: string, channel: string | null, thread = false) => ({
      user: { id: user },
      guildId: channel === null ? null : 'g',
      channel: channel === null ? {} : { isThread: () => thread, parentId: channel, id: thread ? 'thread-id' : channel },
    })
    // DM: allowFrom only
    expect(clickAllowed(click(owner, null), access)).toBe(true)
    expect(clickAllowed(click(other, null), access)).toBe(false)
    // a channel that is not opted in: nobody
    expect(clickAllowed(click(owner, 'elsewhere'), access)).toBe(false)
    // mention-only channel: a click carries no mention, so allowFrom only
    expect(clickAllowed(click(owner, 'mention'), access)).toBe(true)
    expect(clickAllowed(click(other, 'mention'), access)).toBe(false)
    // a channel that listens to every message: anyone there
    expect(clickAllowed(click(other, 'open'), access)).toBe(true)
    // the channel's own allowFrom wins
    expect(clickAllowed(click(other, 'team'), access)).toBe(true)
    expect(clickAllowed(click(owner, 'team'), access)).toBe(false)
    // a thread is judged by its parent channel
    expect(clickAllowed(click(other, 'open', true), access)).toBe(true)
  })
})

describe('channels.sh wiring', () => {
  const sh = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf-8')
  const code = sh.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  const CALL = 'scripts/patch-discord-plugin.py" --state "$INSTALL_DIR/store/discord-plugin-patch.json"'

  it('calls the patcher when Discord is the provider or co-listened, before the session is spawned', () => {
    const call = code.indexOf(CALL)
    const spawn = code.indexOf('$TMUX new-session -d -s "$SESSION"')
    expect(call).toBeGreaterThan(0)
    expect(spawn).toBeGreaterThan(call)
    const cond = code.lastIndexOf('case " $CHANNEL_PROVIDER $CHANNEL_PLUGINS_EXTRA " in', call)
    expect(cond).toBeGreaterThan(0)
    expect(code.slice(cond, call).split('\n').length).toBeLessThanOrEqual(4)
    expect(code.split(CALL).length - 1).toBe(2)
  })

  it('the guard matches discord as provider and discord@... as an extra plugin, nothing else', () => {
    const m = code.match(/case " \$CHANNEL_PROVIDER \$CHANNEL_PLUGINS_EXTRA " in\n\s*(.+)\)\n/)
    expect(m).not.toBeNull()
    const test = (provider: string, extra: string) =>
      spawnSync('bash', ['-c', `case " $1 $2 " in ${m![1]}) echo yes ;; *) echo no ;; esac`, '_', provider, extra], { encoding: 'utf-8' }).stdout.trim()
    expect(test('discord', '')).toBe('yes')
    expect(test('telegram', 'discord@claude-plugins-official')).toBe('yes')
    expect(test('telegram', '')).toBe('no')
    expect(test('slack', 'slack-channel@x')).toBe('no')
    expect(test('telegram', 'mydiscord@x')).toBe('no')
  })

  it('an isolated/explicit config dir is handed to the patcher', () => {
    expect(code).toMatch(/if \[ -n "\$CFG_ENV" \]; then\n\s*CLAUDE_CONFIG_DIR="\$_cfg_dir" python3 "\$INSTALL_DIR\/scripts\/patch-discord-plugin\.py"/)
  })
})
