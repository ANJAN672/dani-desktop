#!/usr/bin/env python3
import json,os,subprocess,sys,tempfile,threading
root=os.path.abspath(sys.argv[1]); exe=os.path.join(root,'bin','opencode-acp')
env=dict(os.environ,HOME=tempfile.mkdtemp(prefix='opencode-probe-'),XDG_CONFIG_HOME=tempfile.mkdtemp(prefix='opencode-config-'))
p=subprocess.Popen([exe],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,bufsize=1)
t=threading.Timer(45,p.kill); t.start()
try:
 req={'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':1,'clientCapabilities':{'fs':{'readTextFile':False,'writeTextFile':False},'terminal':False}}}
 p.stdin.write(json.dumps(req)+'\n'); p.stdin.flush()
 for line in p.stdout:
  try: msg=json.loads(line)
  except: continue
  if msg.get('id')!=1: continue
  info=msg.get('result',{}).get('agentInfo',{})
  print(json.dumps(msg,indent=2))
  if info.get('name')=='OpenCode' and info.get('version')=='1.18.32': print('PROBE RESULT: PASS (OpenCode 1.18.32, ACP initialize)'); sys.exit(0)
  raise SystemExit('unexpected agentInfo '+repr(info))
 raise SystemExit('no initialize response')
finally: t.cancel(); p.kill()
