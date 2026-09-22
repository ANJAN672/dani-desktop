#!/usr/bin/env python3
import argparse,hashlib,json,os

def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1<<20),b''): h.update(b)
 return h.hexdigest()
def size(root):
 return sum(os.path.getsize(os.path.join(b,f)) for b,_,fs in os.walk(root) for f in fs if not os.path.islink(os.path.join(b,f)))
p=argparse.ArgumentParser(); p.add_argument('--target',required=True); p.add_argument('--payload-dir',required=True); p.add_argument('--archive',required=True); p.add_argument('--out',required=True); a=p.parse_args()
m={'manifestVersion':1,'name':'opencode-runtime-payload','target':a.target,'version':'1.18.32','upstreamCommit':'f5ce4f881e477c7b75421cea2d20939f0ddd71fb','archiveSha256':sha(a.archive),'archiveSize':os.path.getsize(a.archive),'unpackedSize':size(a.payload_dir),'format':'tar.gz','executableRelPath':'bin/opencode-acp','probe':{'expectedAgentName':'OpenCode','argv':['probe/run-probe.sh'],'protocol':'acp-jsonrpc-stdio: spawn executableRelPath, send initialize {protocolVersion:1, clientCapabilities:{fs:{readTextFile:false,writeTextFile:false}, terminal:false}}, expect result.agentInfo','expectedVersion':'1.18.32'},'noticeRelPath':'NOTICE','sbomRelPath':'SBOM.cdx.json','degradations':[]}
json.dump(m,open(a.out,'w'),indent=2); print(m['archiveSha256'])
