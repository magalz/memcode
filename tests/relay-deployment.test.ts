import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const template = JSON.parse(await readFile(new URL("../deploy/aws/relay.template.json", import.meta.url), "utf8"));
const resources = template.Resources;
const bootstrap = await readFile(new URL("../deploy/aws/relay.bootstrap.sh", import.meta.url), "utf8");

test("dedicated relay exposes only public HTTP/TLS and requires temporary managed access", () => {
  const rules = resources.SecurityGroup.Properties.SecurityGroupIngress;
  assert.deepEqual(rules.map((rule: { FromPort: number }) => rule.FromPort), [80, 443]);
  assert(rules.every((rule: { FromPort: number; ToPort: number; IpProtocol: string }) => rule.FromPort === rule.ToPort && rule.IpProtocol === "tcp"));
  assert.equal(resources.Host.Properties.KeyName, undefined);
  assert.equal(resources.Host.Properties.MetadataOptions.HttpTokens, "required");
  assert.equal(resources.Host.Properties.CreditSpecification.CPUCredits, "standard");
  assert.equal(resources.RuntimeRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service, "ec2.amazonaws.com");
  const deny = resources.RuntimeRole.Properties.Policies[0].PolicyDocument.Statement.find((entry: { Sid?: string }) => entry.Sid === "NoParameterStoreReads");
  assert.equal(deny.Effect, "Deny");
  assert.deepEqual(deny.Action, ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]);
  assert.equal(deny.Resource, "*");
  assert(resources.AuditTrail.Properties.AdvancedEventSelectors.every((selector: { FieldSelectors: { Field: string; Equals?: string[] }[] }) => selector.FieldSelectors.find(entry => entry.Field === "eventCategory")?.Equals?.[0] === "Data"));
});

test("private state survives host replacement and has no public release-bucket dependency", () => {
  assert.equal(resources.DataVolume.DeletionPolicy, "Retain");
  assert.equal(resources.DataVolume.UpdateReplacePolicy, "Retain");
  assert.equal(resources.DataVolume.Properties.Encrypted, true);
  for (const name of ["ArtifactBucket", "BackupBucket", "AuditBucket"]) {
    assert.deepEqual(Object.values(resources[name].Properties.PublicAccessBlockConfiguration), [true, true, true, true]);
    assert.equal(resources[name].DeletionPolicy, "Retain");
    assert.equal(resources[name].Properties.VersioningConfiguration.Status, "Enabled");
    assert.equal(resources[name].Properties.LifecycleConfiguration.Rules[0].ExpirationInDays, 30);
  }
  assert.equal(resources.DataKey.DeletionPolicy, "Retain");
  assert(!JSON.stringify(template).includes("MemCodeBetaDistribution"));
});

test("private buckets reject plaintext transport and the instance role cannot publish arbitrary objects", () => {
  for (const name of ["ArtifactPolicy", "BackupPolicy", "AuditPolicy"]) {
    const statement = resources[name].Properties.PolicyDocument.Statement.find((entry: { Effect: string; Condition?: unknown }) => entry.Effect === "Deny");
    assert.equal(statement.Condition.Bool["aws:SecureTransport"], "false");
  }
  const statements = resources.RuntimeRole.Properties.Policies[0].PolicyDocument.Statement;
  assert(!statements.some((entry: { Action: unknown }) => JSON.stringify(entry.Action).includes("s3:*")));
  const write = statements.find((entry: { Action: unknown }) => JSON.stringify(entry.Action).includes("s3:PutObject"));
  assert.deepEqual(write.Resource, { "Fn::Sub": "${BackupBucket.Arn}/snapshots/*" });
});

test("backup is quiesced, restarts on failure and restore never replaces existing state", () => {
  assert(bootstrap.includes("systemctl stop memcode-relay\ntrap 'systemctl start memcode-relay"));
  assert(bootstrap.indexOf("systemctl stop memcode-relay\ntrap") < bootstrap.indexOf("tar -czf /tmp/memcode-state-backup"));
  assert(bootstrap.includes("if not any((root/'state').iterdir()):"));
  assert(bootstrap.includes("member.issym() or member.islnk()"));
  assert(bootstrap.includes("data.extractall(root,filter='data')"));
  assert(bootstrap.includes("sum(member.size for member in members)>16*1024**3"));
  assert(bootstrap.includes("--exclude=state/relay.lock"));
  assert(bootstrap.includes("RequiresMountsFor=/var/lib/memcode"));
});

test("downloaded runtimes are pinned and verified before rootless services can start", async () => {
  const pins = JSON.parse(await readFile(new URL("../deploy/aws/relay-runtimes.json", import.meta.url), "utf8"));
  for (const entry of [pins.node, pins.caddy]) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert(entry.url.startsWith("https://"));
    assert(entry.url.includes(entry.version));
  }
  assert.match(pins.caddy.sha512, /^[a-f0-9]{128}$/);
  assert(bootstrap.includes("sha256sum --check --status"));
  assert(bootstrap.includes("sha512sum --check --status"));
  assert(bootstrap.includes("User=memcode\n"));
  assert(bootstrap.includes("User=memcode-caddy\n"));
  assert(bootstrap.includes("ProtectSystem=strict"));
  assert(bootstrap.includes("request_body {\n    max_size 8MB\n  }"));
  assert(!bootstrap.includes("curl |"));
});

test("private bundle installer rejects substitutions and cannot unpack source or state", async () => {
  const installer = await readFile(new URL("../deploy/aws/install-relay.py", import.meta.url), "utf8");
  assert(installer.includes('re.fullmatch(r"[a-f0-9]{64}", digest)'));
  assert(installer.includes('hashlib.file_digest(archive.open("rb"), "sha256").hexdigest() != digest'));
  assert(installer.includes('{"relay.cjs", "start.cjs", "provenance.json", "LICENSE", "NOTICE"}'));
  assert(installer.includes("any(not member.isfile() for member in members)"));
  assert(installer.includes('filter="data"'));
  assert(!installer.includes('"admin.private.json"'));
});

test("template references are declared and explicit resource dependencies do not form cycles", () => {
  const dependencies = new Map<string, Set<string>>();
  const visit = (value: unknown, found: Set<string>) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(entry => visit(entry, found)); return; }
    for (const [key, entry] of Object.entries(value)) {
      if (key === "Ref" && typeof entry === "string") {
        assert(entry.startsWith("AWS::") || template.Parameters[entry] || resources[entry], `Unknown ${entry}`);
        if (resources[entry]) found.add(entry);
      } else if (key === "Fn::GetAtt" && Array.isArray(entry)) {
        assert(resources[entry[0]]);
        found.add(entry[0]);
      } else if (key === "DependsOn") for (const name of typeof entry === "string" ? [entry] : entry as string[]) { assert(resources[name]); found.add(name); }
      else visit(entry, found);
    }
  };
  for (const [name, value] of Object.entries(resources)) { const found = new Set<string>(); visit(value, found); dependencies.set(name, found); }
  const resolve = (name: string, stack: Set<string>) => { assert(!stack.has(name), `Resource cycle: ${[...stack, name].join(" -> ")}`); for (const next of dependencies.get(name) ?? []) resolve(next, new Set([...stack, name])); };
  for (const name of dependencies.keys()) resolve(name, new Set());
  assert(Buffer.byteLength(JSON.stringify(template)) < 51_200);
  const userDataParts = resources.Host.Properties.UserData["Fn::Base64"]["Fn::Join"][1];
  assert(userDataParts.reduce((size: number, part: unknown) => size + (typeof part === "string" ? part.length : 100), 0) < 16_384);
});
