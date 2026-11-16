"""Replay the newest actual private checkpoint in an isolated loopback relay.

Run after a controlled backup with no active verification client. Does not
overwrite live state or print documents, identity tokens or capabilities.
"""
import boto3
import hashlib
import json
import pathlib
import subprocess
import tarfile
import tempfile

root = pathlib.Path("/var/lib/memcode")
with open("/etc/memcode-relay/config.json") as file:
    config = json.load(file)
client = boto3.client("s3", region_name=config["region"])
entries = []
for page in client.get_paginator("list_objects_v2").paginate(Bucket=config["backupBucket"], Prefix="snapshots/"):
    entries.extend(item for item in page.get("Contents", []) if item["Key"].endswith(".tar.gz"))
if not entries:
    raise RuntimeError("No private checkpoint exists")
latest = max(entries, key=lambda item: item["LastModified"])
metadata = client.head_object(Bucket=config["backupBucket"], Key=latest["Key"])
if metadata.get("ServerSideEncryption") != "aws:kms":
    raise RuntimeError("Private checkpoint encryption is not the reviewed KMS policy")


def hashes(directory):
    result = {}
    for file in directory.rglob("*"):
        if file.is_symlink():
            raise RuntimeError("Unexpected link in Team checkpoint")
        if file.is_file() and file.name not in ("relay.lock", "ready.private.json"):
            with file.open("rb") as stream:
                result[str(file.relative_to(directory))] = hashlib.file_digest(stream, "sha256").hexdigest()
    return result


before = hashes(root / "state")
with tempfile.TemporaryDirectory(prefix="verification-restore-", dir=root) as directory:
    directory = pathlib.Path(directory)
    archive = directory / "checkpoint.tar.gz"
    client.download_file(config["backupBucket"], latest["Key"], str(archive))
    restored = directory / "restored"
    restored.mkdir(mode=0o700)
    with tarfile.open(archive, "r:gz") as data:
        members = data.getmembers()
        if len(members) > 200000 or sum(member.size for member in members) > 16 * 1024**3:
            raise RuntimeError("Checkpoint expansion exceeds the dedicated state limit")
        if any(member.name.split("/")[0] not in ("state", "caddy") or member.issym() or member.islnk() for member in members):
            raise RuntimeError("Unsafe checkpoint path or link")
        data.extractall(restored, filter="data")
    if hashes(restored / "state") != before:
        raise RuntimeError("Checkpoint differs from quiesced live Team state")
    code = """(async()=>{
      const relay=await require('/opt/memcode-relay/relay.cjs').startTeamRelay({
        dataDir:process.argv[1],host:'127.0.0.1',port:0,
        advertisedUrl:process.argv[2],selfServiceTeams:true,maxTeamsPerAccount:3});
      try{const result=await(await fetch(relay.url+'/v1/service')).json();
        if(result.version!==1||result.selfServiceTeams!==true)throw Error('Restored relay did not start');
      }finally{await relay.close();}
    })().catch(error=>{console.error('Private checkpoint replay failed:',error.message);process.exitCode=1;});"""
    subprocess.run(["/opt/memcode-runtime/bin/node", "-e", code, str(restored / "state"), config["publicURL"]], check=True)
if hashes(root / "state") != before:
    raise RuntimeError("Live Team state unexpectedly changed during isolated restore verification")
print(json.dumps({"privateCheckpointEncrypted": True, "restoredFilesMatch": True, "restoredRelayParsedAndStarted": True, "liveStateUnchanged": True, "fileCount": len(before)}))
