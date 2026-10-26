import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Briefing, Status } from '../types'

const PANE = 'system1-options'
// Override with SYSTEM1_CLIENT (absolute path) and SYSTEM1_PYTHON when the relative path or `python3` is wrong
// for the machine: on Windows `python3` is usually the Store stub. Read defensively, so a runtime without
// `process` still falls back to the original values. Not loaded or tested in Claude Code yet.
const env = (globalThis as { process?: { env?: Record<string, string | undefined>; platform?: string } }).process
const CLIENT = env?.env?.SYSTEM1_CLIENT ?? 'orchestrator-options/client/system1_client.py'
const PYTHON = env?.env?.SYSTEM1_PYTHON ?? (env?.platform === 'win32' ? 'python' : 'python3')
const TEN_MINUTES = 600_000

type ClientOutput = {
  briefing: Briefing
  system1_response: string | null
  error: string | null
}

const briefing = atom({ plugin: 'system1-options', key: 'briefing' } as const, null as Briefing | null)
const status = atom({ plugin: 'system1-options', key: 'status' } as const, { kind: 'idle' } as Status)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'system1',
      description: 'Brief System 1 autonomously (xhigh options, no questions): /system1 <task>',
    })

    return next(e)
  })

  on('command.run', { command: 'system1' }, async ($, e) => {
    const task = e.args.trim()
    if (task === '') {
      return { text: 'Usage: /system1 <task to hand to System 1>' }
    }

    await update($, status, () => ({ kind: 'thinking', task }))
    await update($, briefing, () => null)
    await $.ui.open({ id: PANE, title: 'System 1 options' })

    void $.process
      .run([PYTHON, CLIENT, 'options', task, '--json'], { timeoutMs: TEN_MINUTES })
      .then(async ran => {
        let out: ClientOutput | null = null
        try {
          out = JSON.parse(ran.stdout) as ClientOutput
        } catch {
          out = null
        }
        if (out === null) {
          const message = ran.stderr.trim().split('\n').pop() || 'client failed'
          await update($, status, () => ({ kind: 'error', message }))
          return
        }
        await update($, briefing, () => out.briefing)
        await update($, status, () =>
          out.error === null
            ? { kind: 'sent', reply: (out.system1_response ?? '').trim().slice(0, 300) }
            : { kind: 'error', message: `Not sent: ${out.error}` },
        )
      })
      .catch(async err => {
        await update($, status, () => ({ kind: 'error', message: String(err) }))
      })

    return { text: 'Reasoning at xhigh effort; the briefing is sent to System 1 when ready.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const state = await read($, status)
    const current = await read($, briefing)

    if (state.kind === 'idle') {
      return <Text dimColor>Run /system1 &lt;task&gt; to brief System 1.</Text>
    }
    if (state.kind === 'thinking') {
      return <Text>Reasoning at xhigh effort on: {state.task}</Text>
    }
    if (current === null) {
      return <Text color="red">System 1 client: {state.kind === 'error' ? state.message : 'no briefing'}</Text>
    }

    return (
      <Box flexDirection="column">
        {state.kind === 'sent' && <Text color="green">Sent to System 1 (autonomous): {state.reply}</Text>}
        {state.kind === 'error' && <Text color="red">{state.message}</Text>}
        <Text bold>{current.decision}</Text>
        <Text dimColor>{current.situation}</Text>
        {current.options.map(o => (
          <Box key={o.id} flexDirection="column">
            <Text> </Text>
            <Text bold>
              [{o.id}] {o.title}
              {o.id === current.recommendation.option_id ? '  (recommended)' : ''}
            </Text>
            <Text>{o.summary}</Text>
            <Text dimColor>
              cost {o.cost} · risk {o.risk} · reversibility {o.reversibility} · {o.time_to_value}
            </Text>
          </Box>
        ))}
        <Text> </Text>
        <Text>{current.recommendation.rationale}</Text>
        <Text dimColor>Selection rule: {current.selection_guidance}</Text>
      </Box>
    )
  })
}
