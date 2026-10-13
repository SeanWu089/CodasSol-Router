import pathlib, shutil, subprocess, urllib.request, json, time, os, datetime
source=pathlib.Path(__file__).resolve().parents[1]
runtime=pathlib.Path.home()/'.local/share/codassol-router'
backup=pathlib.Path.home()/'.local/share/codassol-router-upgrades'/('no-vpn-sse-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
backup.mkdir(parents=True)
names=['server.js','agent-hub.js','device-registry.js','agent-timing.js','peer-mesh.js']
def health():
 return json.load(urllib.request.urlopen('http://127.0.0.1:17676/_codassol/health',timeout=3))
def backend_pid():
 return subprocess.check_output(['/usr/sbin/lsof','-t','-iTCP:7676','-sTCP:LISTEN'],text=True).strip()
before=backend_pid()
existed={}
for name in names:
 p=runtime/'src'/name;existed[name]=p.exists()
 if p.exists():shutil.copy2(p,backup/name)
def restart():
 subprocess.run(['launchctl','kickstart','-k',f'gui/{os.getuid()}/com.codassol.router'],check=True,timeout=20)
def ready():
 for _ in range(20):
  time.sleep(1)
  try:
   h=health()
   if h.get('ok') and h.get('backendReachable') and backend_pid()==before:return
  except Exception:pass
 raise RuntimeError('Router readiness gate failed')
try:
 for name in names:shutil.copy2(source/'src'/name,runtime/'src'/name)
 restart();ready()
 if json.loads((pathlib.Path.home()/'.codassol/peers.json').read_text()):raise RuntimeError('Unexpected active peers')
 result={'result':'PASS','backendPidPreserved':before,'activePeers':0,'backup':str(backup)}
except Exception as e:
 for name in names:
  p=runtime/'src'/name
  if existed[name]:shutil.copy2(backup/name,p)
  elif p.exists():p.unlink()
 restart();ready()
 result={'result':'ROLLED_BACK','reason':type(e).__name__,'backup':str(backup)}
(backup/'result.json').write_text(json.dumps(result))
print(json.dumps(result))
