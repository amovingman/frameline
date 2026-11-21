'use strict';
// Calibrate the supported internal Python runtime on a private sentinel only.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomBytes}=require('node:crypto');
const {readInput}=require('./integration-input');
const {owned,json,sha}=require('./prepare-preservation-session');
const {binarySentinel}=require('./prepare-preservation-minimal-name');
const ROOT=path.resolve(__dirname,'..'),q=JSON.stringify;
const SOURCES=['phase-0/prepare-preservation-python-probe.js','phase-0/prepare-preservation-session.js','phase-0/prepare-preservation-minimal-name.js'];
const hashes=()=>Object.fromEntries(SOURCES.map(p=>[p,sha(readInput(path.join(ROOT,p)))]));
function renderPreservationPythonProbe(r){return `# Private binary sentinel only. No project changes, library writes or loads.
import os, stat, json, hashlib, sys
from pathlib import Path
record = json.loads(${q(JSON.stringify({probeId:r.probeId,directory:r.directory,sentinelPath:r.sentinelPath,sentinelSha256:r.sentinelSha256,sentinelBytes:r.sentinelBytes,paths:r.paths}))})
def publish(file, data):
    directory = Path(record['directory'])
    s = directory.lstat()
    assert directory.resolve() == directory and stat.S_ISDIR(s.st_mode) and s.st_uid == os.getuid() and not s.st_mode & 0o077
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        d = os.fstat(fd)
        assert (s.st_dev,s.st_ino) == (d.st_dev,d.st_ino) and Path(file).parent == directory
        with os.fdopen(os.open(Path(file).name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd),'wb') as f:
            f.write(data);f.flush();os.fsync(f.fileno())
        os.fsync(fd)
    finally:
        os.close(fd)
    assert Path(file).read_bytes() == data
for file in record['paths'].values():
    assert not os.path.lexists(file), 'Output exists'
stage = 'binary-read'
try:
    p = Path(record['sentinelPath'])
    assert p.resolve() == p and p.parent == Path(record['directory'])
    with os.fdopen(os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
        before = os.fstat(f.fileno())
        assert stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and before.st_nlink == 1 and before.st_size == record['sentinelBytes']
        raw = f.read(record['sentinelBytes'] + 1)
        eof = f.read(1)
        after = os.fstat(f.fileno())
        assert len(raw) == record['sentinelBytes'] and eof == b'' and f.tell() == record['sentinelBytes']
        assert (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns) == (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)
    assert hashlib.sha256(raw).hexdigest() == record['sentinelSha256']
    stage = 'sdk-read-only'
    sdk, access = globals().get('resolve'), 'provided-global'
    if sdk is None or not hasattr(sdk,'GetVersion'):
        access = 'scriptapp-fallback'
        try:
            import DaVinciResolveScript as dvr_script
            sdk = dvr_script.scriptapp('Resolve')
        except Exception:
            sdk = None
    facts = {'status':'unavailable'}
    if sdk is not None:
        try:
            version, product, studio = sdk.GetVersionString(), sdk.GetProductName(), sdk.IsStudio()
            facts = {'status':'captured','version':version,'product':product,'studio':studio}
        except Exception:
            facts = {'status':'unavailable'}
    connected = facts == {'status':'captured','version':'21.1.2.10','product':'DaVinci Resolve','studio':False}
    result = {'schemaVersion':1,'operation':'resolve-preservation-python-binary-probe','probeId':record['probeId'],'status':'captured','stage':'complete','runtimePythonVersion':sys.version.split()[0],'runtimePlatform':sys.platform,'resolveAccess':access,'sdk':facts,'sdkTargetConnected':connected,'sentinelBytes':len(raw),'sentinelSha256':hashlib.sha256(raw).hexdigest(),'binarySentinelFidelityProven':True,'eofVerified':True,'readOnly':True,'sourceDatabaseRead':False,'projectLoadSaveClosePerformed':False,'contentSettersPerformed':False,'ordinaryApplySupported':False,'safeToApply':False}
    publish(record['paths']['result'],json.dumps(result,sort_keys=True,separators=(',',':')).encode()+bytes([10]))
    publish(record['paths']['marker'],('FRAMELINE_PRESERVATION_PYTHON_PROBE_COMPLETE:'+record['probeId']+chr(10)).encode())
except Exception as error:
    result = {'schemaVersion':1,'operation':'resolve-preservation-python-probe-error','probeId':record['probeId'],'stage':stage,'errorType':type(error).__name__,'safeToApply':False}
    publish(record['paths']['error'],json.dumps(result,sort_keys=True,separators=(',',':')).encode()+bytes([10]))
`;}
async function preparePreservationPythonProbe({install=false}={}){const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'frameline-preservation-python-probe-')));await fs.chmod(directory,0o700);const probeId=randomBytes(16).toString('hex'),sentinel=binarySentinel(),r={schemaVersion:1,operation:'prepare-preservation-python-probe',directory,probeId,sentinelPath:path.join(directory,'sentinel.bin'),sentinelBytes:sentinel.length,sentinelSha256:sha(sentinel),paths:Object.fromEntries(['result','marker','error'].map(k=>[k,path.join(directory,k+(k==='marker'?'.txt':'.json'))])),sourceHashes:hashes()};await fs.writeFile(r.sentinelPath,sentinel,{flag:'wx',mode:0o600});r.sourcePath=path.join(directory,`Frameline Preservation Python Probe ${probeId.slice(0,12)}.py`);const source=renderPreservationPythonProbe(r);r.sourceSha256=sha(source);await fs.writeFile(r.sourcePath,source,{flag:'wx',mode:0o600});r.installedPath=install?path.join(os.homedir(),'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility',path.basename(r.sourcePath)):null;if(install){const parent=path.dirname(r.installedPath),s=await fs.lstat(parent);if(!s.isDirectory()||s.uid!==process.getuid()||await fs.realpath(parent)!==parent)throw new Error('unsafe-python-probe-install');await fs.writeFile(r.installedPath,source,{flag:'wx',mode:0o600});}const preparation=path.join(directory,'preparation.json');await fs.writeFile(preparation,JSON.stringify(r,null,2)+'\n',{flag:'wx',mode:0o600});return{preparation,sourceSha256:r.sourceSha256,menuName:path.basename(r.sourcePath,'.py')};}
async function readPreservationPythonProbe(preparation){const r=JSON.parse(await owned(preparation)),directory=path.dirname(preparation);if(r.schemaVersion!==1||r.operation!=='prepare-preservation-python-probe'||r.directory!==directory||!/^[a-f0-9]{32}$/.test(r.probeId)||r.sourcePath!==path.join(directory,`Frameline Preservation Python Probe ${r.probeId.slice(0,12)}.py`)||r.sentinelPath!==path.join(directory,'sentinel.bin')||r.sentinelBytes!==binarySentinel().length||r.sentinelSha256!==sha(binarySentinel())||json(r.paths)!==json(Object.fromEntries(['result','marker','error'].map(k=>[k,path.join(directory,k+(k==='marker'?'.txt':'.json'))]))))throw new Error('invalid-python-probe-record');if(json(r.sourceHashes)!==json(hashes())||sha(await owned(r.sourcePath))!==r.sourceSha256||(await owned(r.sourcePath)).toString()!==renderPreservationPythonProbe(r)||!(await owned(r.sentinelPath)).equals(binarySentinel()))throw new Error('python-probe-source-changed');try{return{status:'native-error',error:JSON.parse(await owned(r.paths.error,true)),safeToApply:false};}catch(e){if(e.code!=='ENOENT')throw e;}try{if((await owned(r.paths.marker,true)).toString()!==`FRAMELINE_PRESERVATION_PYTHON_PROBE_COMPLETE:${r.probeId}\n`)throw new Error('python-probe-marker-differs');}catch(e){if(e.code==='ENOENT')return{status:'not-complete',doNotReplay:true,safeToApply:false};throw e;}const raw=await owned(r.paths.result,true),v=JSON.parse(raw);if(v.schemaVersion!==1||v.operation!=='resolve-preservation-python-binary-probe'||v.probeId!==r.probeId||v.status!=='captured'||v.stage!=='complete'||v.sentinelBytes!==r.sentinelBytes||v.sentinelSha256!==r.sentinelSha256||v.binarySentinelFidelityProven!==true||v.eofVerified!==true||v.readOnly!==true||v.sourceDatabaseRead!==false||v.projectLoadSaveClosePerformed!==false||v.contentSettersPerformed!==false||v.ordinaryApplySupported!==false||v.safeToApply!==false||v.sdkTargetConnected!==(v.sdk.status==='captured'&&v.sdk.version==='21.1.2.10'&&v.sdk.product==='DaVinci Resolve'&&v.sdk.studio===false))throw new Error('python-probe-result-differs');return{...v,sourceSha256:r.sourceSha256,sourceHashes:r.sourceHashes,resultSha256:sha(raw),sourceAndResultVerified:true,losslessValidated:false};}
module.exports={preparePreservationPythonProbe,renderPreservationPythonProbe,readPreservationPythonProbe};
if(require.main===module){const[op,arg]=process.argv.slice(2);(op==='prepare'?preparePreservationPythonProbe({install:arg==='--install'}):op==='read'?readPreservationPythonProbe(arg):Promise.reject(new Error('usage'))).then(v=>process.stdout.write(JSON.stringify(v,null,2)+'\n')).catch(e=>{process.stderr.write('preservation-python-probe-failed:'+e.message+'\n');process.exitCode=1;});}
