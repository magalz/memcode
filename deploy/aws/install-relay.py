"""Run through SSM on the new dedicated host, with a reviewed SHA-256 and key.

No operator/admin capability or identity token is read or printed.
"""
import boto3
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile

digest = sys.argv[1]
if not re.fullmatch(r"[a-f0-9]{64}", digest):
    raise ValueError("A reviewed bundle SHA-256 is required")
with open("/etc/memcode-relay/config.json") as file:
    config = json.load(file)
client = boto3.client("s3", region_name=config["region"])
with tempfile.TemporaryDirectory(prefix="memcode-reviewed-deploy-") as directory:
    archive = pathlib.Path(directory) / "relay.tar.gz"
    client.download_file(config["artifactBucket"], "bundles/" + digest + ".tar.gz", str(archive))
    if hashlib.file_digest(archive.open("rb"), "sha256").hexdigest() != digest:
        raise ValueError("Private software bundle checksum mismatch")
    expected = {"relay.cjs", "start.cjs", "provenance.json", "LICENSE", "NOTICE"}
    with tarfile.open(archive, "r:gz") as data:
        members = data.getmembers()
        if {member.name for member in members} != expected or any(not member.isfile() for member in members):
            raise ValueError("Unexpected file, link or directory in reviewed software bundle")
        data.extractall(pathlib.Path(directory) / "files", filter="data")
    # Preserve live private state. Only replace this dedicated service's code.
    subprocess.run(["systemctl", "stop", "memcode-relay"], check=True)
    try:
        for name in expected:
            subprocess.run(["install", "-o", "root", "-g", "root", "-m", "644", str(pathlib.Path(directory) / "files" / name), "/opt/memcode-relay/" + name], check=True)
        subprocess.run(["/opt/memcode-runtime/bin/node", "--check", "/opt/memcode-relay/start.cjs"], check=True)
        subprocess.run(["/opt/memcode-runtime/bin/node", "--check", "/opt/memcode-relay/relay.cjs"], check=True)
    finally:
        subprocess.run(["systemctl", "start", "memcode-relay"], check=True)
    subprocess.run(["/opt/memcode-runtime/caddy", "validate", "--config", "/etc/memcode-relay/Caddyfile", "--adapter", "caddyfile"], check=True)
    subprocess.run(["systemctl", "start", "memcode-caddy"], check=True)
print("Reviewed private relay bundle installed; source, graphs and Team state were not replaced")
