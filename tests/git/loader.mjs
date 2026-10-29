// Lets node run the hooks' TypeScript against real git: "claude-code" is a
// stub (state is not needed here) and relative imports get their .ts.
import { register } from 'node:module'

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'claude-code') return { url: new URL('./claude-code-stub.mjs', ${JSON.stringify(import.meta.url)}).href, shortCircuit: true }
    if ((spec.startsWith('./') || spec.startsWith('../')) && !/\\.[cm]?[jt]s$/.test(spec)) {
      try { return await next(spec + '.ts', ctx) } catch {}
    }
    return next(spec, ctx)
  }
`))
