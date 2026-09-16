import {interpretWorkStatus} from './runtime-work-idle.mjs'

const probes = [
  {
    name: 'legacy_busy_unexplained',
    data: {
      busy: true,
      counts: {
        async_tasks: 0,
        media_batches: 0,
        production_runs: 0,
        orchestration_blender_jobs: 0,
        local_media_jobs: 0,
        analysis: 0,
      },
    },
    expected_idle: false,
  },
  {
    name: 'legacy_busy_but_paid_unknown',
    data: {
      busy: false,
      counts: {
        async_tasks: 0,
        media_batches: 0,
        production_runs: 0,
        orchestration_blender_jobs: 0,
        local_media_jobs: 0,
        analysis: 0,
        unknown_paid_requests: 1,
      },
    },
    expected_idle: false,
  },
  {
    name: 'v2_contradictory_busy',
    data: {
      schema: 'yinzi.runtime-work-status/v2',
      busy: false,
      blocking: ['execution'],
      readable: true,
      counts: {
        async_tasks: 0,
        media_batches: 0,
        production_runs: 0,
        orchestration_blender_jobs: 0,
        local_media_jobs: 1,
        analysis: 0,
      },
    },
    expected_idle: false,
  },
  {
    name: 'legacy_analysis_context_kept_idle',
    data: {
      busy: true,
      counts: {
        async_tasks: 0,
        media_batches: 0,
        production_runs: 0,
        orchestration_blender_jobs: 0,
        local_media_jobs: 0,
        analysis: 7,
      },
    },
    expected_idle: true,
  },
  {
    name: 'v2_normal_idle_kept',
    data: {
      schema: 'yinzi.runtime-work-status/v2',
      busy: false,
      blocking: [],
      counts: {analysis: 7, local_media_jobs: 0},
    },
    expected_idle: true,
  },
]

const results = probes.map((probe) => {
  const result = interpretWorkStatus({data: probe.data})
  return {
    name: probe.name,
    data: probe.data,
    result,
    expected_idle: probe.expected_idle,
    ok: result.idle === probe.expected_idle,
  }
})

const payload = {
  at: new Date().toISOString(),
  source: 'runtime-adversarial-readback.mjs',
  failed: results.filter((item) => !item.ok).map((item) => item.name),
  probes: results,
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
} else {
  for (const item of results) {
    process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} idle=${item.result.idle} reason=${item.result.reason}\n`)
  }
}

if (payload.failed.length) process.exit(1)
