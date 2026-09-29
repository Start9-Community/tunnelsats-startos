import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import path from 'path'
import yaml from 'yaml'

test('Dependabot Configuration - structured AST validation', () => {
  const dependabotPath = path.join(process.cwd(), '.github', 'dependabot.yml')
  assert.ok(fs.existsSync(dependabotPath), 'dependabot.yml must exist')

  const parsed = yaml.parse(fs.readFileSync(dependabotPath, 'utf8'))
  assert.strictEqual(parsed.version, 2, 'Dependabot version must be 2')
  assert.ok(Array.isArray(parsed.updates), 'updates must be an array')

  const npmUpdate = parsed.updates.find(
    (u: any) => u['package-ecosystem'] === 'npm',
  )
  assert.ok(npmUpdate, 'npm package-ecosystem update entry must exist')
  assert.strictEqual(npmUpdate.directory, '/')
  assert.ok(npmUpdate.groups, 'npm update entry must define groups')
  assert.ok(
    npmUpdate.groups['startos-packages'],
    'startos-packages group must exist',
  )

  const startosPatterns = npmUpdate.groups['startos-packages'].patterns
  assert.ok(
    Array.isArray(startosPatterns),
    'startos-packages patterns must be an array',
  )
  assert.ok(
    startosPatterns.includes('cln-startos'),
    'startos-packages must include cln-startos',
  )
  assert.ok(
    startosPatterns.includes('lnd-startos'),
    'startos-packages must include lnd-startos',
  )

  const actionsUpdate = parsed.updates.find(
    (u: any) => u['package-ecosystem'] === 'github-actions',
  )
  assert.ok(
    actionsUpdate,
    'github-actions package-ecosystem update entry must exist',
  )
})

test('Dependabot Auto-Merge Workflow - structured workflow validation & parsed condition evaluation', () => {
  const workflowPath = path.join(
    process.cwd(),
    '.github',
    'workflows',
    'dependabot-auto-merge.yml',
  )
  assert.ok(fs.existsSync(workflowPath), 'dependabot-auto-merge.yml must exist')

  const parsed = yaml.parse(fs.readFileSync(workflowPath, 'utf8'))
  assert.strictEqual(parsed.name, 'Dependabot Auto-Merge')
  assert.ok(
    parsed.on.pull_request_target,
    'Must trigger on pull_request_target',
  )
  assert.strictEqual(parsed.permissions.contents, 'write')
  assert.strictEqual(parsed.permissions['pull-requests'], 'write')

  const autoMergeJob = parsed.jobs?.['auto-merge']
  assert.ok(autoMergeJob, 'auto-merge job must exist')
  assert.strictEqual(autoMergeJob.if, "github.actor == 'dependabot[bot]'")

  const steps = autoMergeJob.steps
  assert.ok(Array.isArray(steps), 'Job steps must be an array')

  const approveStep = steps.find(
    (s: any) => s.name === 'Auto-approve eligible Dependabot updates',
  )
  const mergeStep = steps.find(
    (s: any) =>
      s.name === 'Enable native auto-merge for eligible Dependabot updates',
  )

  assert.ok(approveStep, 'Auto-approve step must exist')
  assert.ok(mergeStep, 'Enable native auto-merge step must exist')

  const condition = approveStep.if.trim()
  const mergeCondition = mergeStep.if.trim()

  // Verify that approval and merge predicates are strictly identical
  assert.strictEqual(
    condition.replace(/\s+/g, ' '),
    mergeCondition.replace(/\s+/g, ' '),
    'Approval and merge step conditions must be identical',
  )

  // Directly evaluate the actual parsed workflow condition expression against mock metadata
  const evaluateParsedExpression = (
    expr: string,
    meta: {
      updateType: string | null
      dependencyNames: string
      packageEcosystem: string
    },
  ): boolean => {
    // Replace GitHub Actions expression syntax with JS evaluation
    let jsExpr = expr
      .replace(
        /steps\.metadata\.outputs\.update-type/g,
        JSON.stringify(meta.updateType),
      )
      .replace(
        /steps\.metadata\.outputs\.dependency-names/g,
        JSON.stringify(meta.dependencyNames),
      )
      .replace(
        /steps\.metadata\.outputs\.package-ecosystem/g,
        JSON.stringify(meta.packageEcosystem),
      )
      .replace(/contains\(([^,]+),\s*([^)]+)\)/g, '($1 && $1.includes($2))')

    // Run safe boolean evaluation of the parsed expression
    return Function(`"use strict"; return Boolean(${jsExpr});`)()
  }

  // Test matrix against the actual parsed condition string:
  assert.strictEqual(
    evaluateParsedExpression(condition, {
      updateType: 'version-update:semver-minor',
      dependencyNames: 'prettier',
      packageEcosystem: 'npm_and_yarn',
    }),
    true,
    'SemVer minor must be eligible',
  )
  assert.strictEqual(
    evaluateParsedExpression(condition, {
      updateType: 'version-update:semver-patch',
      dependencyNames: 'typescript',
      packageEcosystem: 'npm_and_yarn',
    }),
    true,
    'SemVer patch must be eligible',
  )
  assert.strictEqual(
    evaluateParsedExpression(condition, {
      updateType: null,
      dependencyNames: 'cln-startos',
      packageEcosystem: 'npm_and_yarn',
    }),
    true,
    'cln-startos git SHA bump must be eligible',
  )
  assert.strictEqual(
    evaluateParsedExpression(condition, {
      updateType: null,
      dependencyNames: 'lnd-startos',
      packageEcosystem: 'npm_and_yarn',
    }),
    true,
    'lnd-startos git SHA bump must be eligible',
  )
  assert.strictEqual(
    evaluateParsedExpression(condition, {
      updateType: 'version-update:semver-major',
      dependencyNames: '@start9labs/start-sdk',
      packageEcosystem: 'npm_and_yarn',
    }),
    false,
    'SDK major updates must NOT be eligible',
  )
  assert.strictEqual(
    evaluateParsedExpression(condition, {
      updateType: 'version-update:semver-minor',
      dependencyNames: 'actions/checkout',
      packageEcosystem: 'github_actions',
    }),
    true,
    'GitHub actions minor update must be eligible',
  )
  assert.strictEqual(
    evaluateParsedExpression(condition, {
      updateType: 'version-update:semver-major',
      dependencyNames: 'actions/checkout',
      packageEcosystem: 'github_actions',
    }),
    false,
    'GitHub actions major update must NOT be auto-merged',
  )
})
