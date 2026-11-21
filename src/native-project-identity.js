'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{constants}=require('node:fs'),{execFile}=require('node:child_process'),{promisify}=require('node:util'),{createHash}=require('node:crypto');
const exec=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const hashes={'resolve-native-identity.py':'0d19c4fbb40c338d61386c4a1f3f24bdb20d621b773e3e2b298c314e3adf2f61','resolve-native-sqlite-snapshot.py':'35bc1c7c324f63e7066cf77c22627a3a56a93e66c3427e14cd0bc0aa8a5c82d6'};
async function readProjectIdentity({sourcePath}={}){
 if(typeof sourcePath!=='string'||!path.isAbsolute(sourcePath)||await fs.realpath(sourcePath)!==sourcePath)throw Error('native-identity-canonical-source-required');
 for(const [name,hash]of Object.entries(hashes))if(sha(await fs.readFile(path.join(__dirname,'native/resolve',name)))!==hash)throw Error('native-identity-helper-changed');
 const h=await fs.open(sourcePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let before,bytes;
 try{before=await h.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.uid!==BigInt(process.getuid())||before.size<100n||before.size>128n*1024n*1024n)throw Error('native-identity-file-unsafe');bytes=await h.readFile();}finally{await h.close();}
 const result=await exec('python3',['-B',path.join(__dirname,'native/resolve/resolve-native-identity.py'),sourcePath],{timeout:30000,maxBuffer:1024*1024,encoding:'utf8'});const value=JSON.parse(result.stdout),after=await fs.lstat(sourcePath,{bigint:true});
 if(!['dev','ino','size','mtimeNs','ctimeNs'].every(k=>before[k]===after[k])||value.operation!=='native-project-identity-read'||value.readOnly!==true||value.sourceSha256!==sha(bytes)||value.bytes!==bytes.length)throw Error('native-identity-source-changed');return value;
}
module.exports={readProjectIdentity};
