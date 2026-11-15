import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const source = readFileSync('src/bosshunter/web/frontend/src/Demo.tsx', 'utf8')
assert.match(source, /合成示例/)
assert.match(source, /未接入/)
assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest/)
for (const page of ['工作台', '岗位池', '监测执行', '配置']) assert.ok(source.includes(page))
console.log('Demo isolation and labels verified')
