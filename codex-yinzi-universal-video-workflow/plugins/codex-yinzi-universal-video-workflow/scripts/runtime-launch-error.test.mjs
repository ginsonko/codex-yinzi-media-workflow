import {test} from 'node:test'
import assert from 'node:assert/strict'
import {runtimeLaunchFailure} from './runtime-launch-error.mjs'

test('nonzero launcher stdout wins over process wrapper and unrelated stderr',()=>{
 const error=runtimeLaunchFailure({code:3,stdout:'build log\n'+JSON.stringify({ok:false,error:'前端依赖未安装'})+'\n',stderr:'warning',message:'Command failed'})
 assert.match(error.message,/前端依赖未安装/)
 assert.doesNotMatch(error.message,/安装桌面包|Command failed/)
 assert.equal(error.details.reason_source,'launcher_stdout')
 assert.equal(error.details.exit_code,3)
})
test('invalid or successful stdout falls back without inventing installation cause',()=>{
 for(const stdout of ['bad json',JSON.stringify({ok:true,error:'ignore me'})]) {
  const error=runtimeLaunchFailure({stdout,stderr:'module unavailable',code:1})
  assert.equal(error.details.reason,'module unavailable')
  assert.equal(error.details.reason_source,'launcher_stderr')
 }
 const timed=runtimeLaunchFailure({code:'ETIMEDOUT',signal:'SIGTERM',message:'launcher timed out'})
 assert.equal(timed.details.exit_code,null)
 assert.equal(timed.details.signal,'SIGTERM')
 assert.match(timed.message,/timed out/)
})
test('structured reason is redacted before both user message and details',()=>{
 const error=runtimeLaunchFailure({stdout:JSON.stringify({ok:false,error:'secret-token'})},text=>text.replaceAll('secret-token','[REDACTED]'))
 assert.doesNotMatch(JSON.stringify({message:error.message,details:error.details}),/secret-token/)
})
test('newly surfaced launcher output omits URL credentials and named secrets',()=>{
 const error=runtimeLaunchFailure({stdout:JSON.stringify({ok:false,error:'GET https://alice:private@host.test/start?token=hidden#private password="secret value" api_key=opaque-key Authorization: Bearer short denied'})})
 const visible=JSON.stringify({message:error.message,details:error.details})
 assert.match(visible,/https:\/\/host.test\/start/)
 assert.match(visible,/denied/)
 assert.doesNotMatch(visible,/alice|private|hidden|secret value|opaque-key|short/)
})
test('Authorization schemes do not leave encoded credentials behind',()=>{
 for (const header of ['Authorization: Basic dXNlcjpwYXNz', 'Proxy-Authorization: Bearer opaque', 'Authorization: Digest username="user", response="digest-secret"']) {
  const error=runtimeLaunchFailure({stderr:header+'\nstartup failed'})
  const visible=JSON.stringify({message:error.message,details:error.details})
  assert.doesNotMatch(visible,/dXNlcjpwYXNz|opaque|digest-secret|username/)
  assert.match(visible,/startup failed/)
 }
})
