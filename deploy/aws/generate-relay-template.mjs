import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const directory = new URL('./', import.meta.url);
const runtimes = JSON.parse(await readFile(new URL('relay-runtimes.json', directory), 'utf8'));
const ref = (name) => ({ Ref: name });
const sub = (text) => ({ 'Fn::Sub': text });
const att = (name, attribute) => ({ 'Fn::GetAtt': [name, attribute] });
const context = (why, must = []) => ({ 'com.aws.cloudformation.Context': { why, must } });
const resource = (Type, Properties, why, must = [], extra = {}) => ({ Type, Metadata: context(why, must), Properties, ...extra });
const retained = { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' };
const publicBlock = { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true };
const trailArn = sub('arn:${AWS::Partition}:cloudtrail:${AWS::Region}:${AWS::AccountId}:trail/${AWS::StackName}');
const auditArn = att('AuditBucket', 'Arn');
const makeBucket = (prefix, days) => resource('AWS::S3::Bucket', {
  PublicAccessBlockConfiguration: publicBlock,
  OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
  BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: att('DataKey', 'Arn') }, BucketKeyEnabled: true }] },
  VersioningConfiguration: { Status: 'Enabled' },
  LoggingConfiguration: { DestinationBucketName: ref('AuditBucket'), LogFilePrefix: `access/${prefix}/` },
  LifecycleConfiguration: { Rules: [{ Id: 'BoundedPrivateRetention', Status: 'Enabled', ExpirationInDays: days, NoncurrentVersionExpiration: { NoncurrentDays: days }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] },
}, `Private ${prefix} storage is isolated from public release distribution.`, ['Never enable public access or reuse the public releases bucket.'], retained);

let bootstrap = await readFile(new URL('relay.bootstrap.sh', directory), 'utf8');
const replacements = {
  DATA_VOLUME: ref('DataVolume'), REGION: ref('AWS::Region'), ARTIFACT_BUCKET: ref('ArtifactBucket'), BACKUP_BUCKET: ref('BackupBucket'), HOSTNAME: ref('RelayHostname'),
  NODE_URL: runtimes.node.url, NODE_SHA256: runtimes.node.sha256, NODE_VERSION: runtimes.node.version,
  CADDY_URL: runtimes.caddy.url, CADDY_SHA256: runtimes.caddy.sha256, CADDY_SHA512: runtimes.caddy.sha512, CADDY_VERSION: runtimes.caddy.version,
};
const parts = bootstrap.split(/@@([A-Z0-9_]+)@@/g).map((value, i) => i % 2 ? replacements[value] ?? (() => { throw Error(`Unknown bootstrap field ${value}`); })() : value);

const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'Dedicated authenticated MemCode beta Team relay with private retained state; isolated from local workers, graphs and public downloads.',
  Metadata: { AWSToolsMetrics: { AWSAgentToolkit: 'aws-cloudformation@3' }, 'com.aws.cloudformation.Context': { arch: 'Single arm64 pilot host; Caddy TLS -> loopback rootless Node; retained encrypted EBS + daily private S3 backup.', must: ['Existing application stacks, instances, data and pilot tunnels remain untouched.', 'Only board/comments/activity/explicit results are shared; no source or local graph replication.', 'Deployment requires reviewed SHA-256 bundle and exact Memtrace JWT audience.'], ref: [{ at: 'deploy/aws/relay.md', has: 'operations, limitations, costs and restore' }] } },
  Parameters: {
    RelayHostname: { Type: 'String', Default: 'teams.hosted.memtrace.io', AllowedPattern: '^[a-z0-9][a-z0-9.-]+[a-z0-9]$' },
    HostedZoneId: { Type: 'AWS::Route53::HostedZone::Id', Description: 'Existing public parent zone; only the new RelayHostname record is created.' },
    UbuntuImage: { Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>', Default: '/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id' },
    AvailabilityZone: { Type: 'AWS::EC2::AvailabilityZone::Name', Description: 'Pin the retained data volume and host to the same reviewed zone.' },
  },
  Resources: {
    Vpc: resource('AWS::EC2::VPC', { CidrBlock: '10.73.0.0/24', EnableDnsSupport: true, EnableDnsHostnames: true }, 'A dedicated network prevents changes to existing application VPCs.'),
    Gateway: resource('AWS::EC2::InternetGateway', {}, 'Outbound SSM and HTTPS ACME access without a NAT gateway.'),
    GatewayAttachment: resource('AWS::EC2::VPCGatewayAttachment', { InternetGatewayId: ref('Gateway'), VpcId: ref('Vpc') }, 'Attach only the new pilot VPC.'),
    Subnet: resource('AWS::EC2::Subnet', { VpcId: ref('Vpc'), CidrBlock: '10.73.0.0/26', AvailabilityZone: ref('AvailabilityZone'), MapPublicIpOnLaunch: false }, 'One pilot subnet; static EIP supplies the single billable public address.'),
    RouteTable: resource('AWS::EC2::RouteTable', { VpcId: ref('Vpc') }, 'Routes are exclusive to this new subnet.'),
    Route: resource('AWS::EC2::Route', { RouteTableId: ref('RouteTable'), DestinationCidrBlock: '0.0.0.0/0', GatewayId: ref('Gateway') }, 'HTTPS endpoint and outbound management require Internet routing.', [], { DependsOn: 'GatewayAttachment' }),
    RouteAssociation: resource('AWS::EC2::SubnetRouteTableAssociation', { SubnetId: ref('Subnet'), RouteTableId: ref('RouteTable') }, 'Do not modify other subnet associations.'),
    SecurityGroup: resource('AWS::EC2::SecurityGroup', { GroupDescription: 'Public team HTTPS and ACME only; no SSH or direct relay', VpcId: ref('Vpc'), SecurityGroupIngress: [80, 443].map((port) => ({ IpProtocol: 'tcp', FromPort: port, ToPort: port, CidrIp: '0.0.0.0/0', Description: port === 80 ? 'HTTP redirects and ACME validation' : 'Authenticated desktop team clients over HTTPS' })), SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '0.0.0.0/0', Description: 'OS updates, SSM, public JWKS, ACME and private AWS APIs' }] }, 'Remote beta clients have changing addresses; public entry is restricted to web ports.', ['Never expose SSH, loopback relay, filesystem, graph or management port.']),
    DataKey: resource('AWS::KMS::Key', { Description: 'Private MemCode beta state, backup and audit encryption', EnableKeyRotation: true, KeyPolicy: { Version: '2012-10-17', Statement: [
      { Sid: 'AccountIAMAdministration', Effect: 'Allow', Principal: { AWS: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:root') }, Action: 'kms:*', Resource: '*' },
      { Sid: 'ScopedCloudTrailEncryption', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: ['kms:GenerateDataKey*', 'kms:DescribeKey'], Resource: '*', Condition: { StringEquals: { 'aws:SourceArn': trailArn }, StringLike: { 'kms:EncryptionContext:aws:cloudtrail:arn': trailArn } } },
    ] } }, 'Separate encryption boundary; retain key while any state or backups survive.', ['Do not schedule deletion while encrypted state remains.'], retained),
    AuditBucket: resource('AWS::S3::Bucket', { PublicAccessBlockConfiguration: publicBlock, OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] }, BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] }, VersioningConfiguration: { Status: 'Enabled' }, LifecycleConfiguration: { Rules: [{ Id: 'PrivateAudit30Days', Status: 'Enabled', ExpirationInDays: 30, NoncurrentVersionExpiration: { NoncurrentDays: 30 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] } }, 'Private audit/access logs; default SSE-S3 permits S3 server-access logging and CloudTrail uses the dedicated KMS key.', ['No public logs; bounded retention.'], retained),
    ArtifactBucket: makeBucket('software', 30),
    BackupBucket: makeBucket('state', 30),
    AuditPolicy: resource('AWS::S3::BucketPolicy', { Bucket: ref('AuditBucket'), PolicyDocument: { Version: '2012-10-17', Statement: [
      { Sid: 'TLSOnly', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [auditArn, sub('${AuditBucket.Arn}/*')], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
      { Sid: 'TrailACL', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:GetBucketAcl', Resource: auditArn, Condition: { StringEquals: { 'aws:SourceArn': trailArn } } },
      { Sid: 'TrailWrite', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:PutObject', Resource: sub('${AuditBucket.Arn}/trail/AWSLogs/${AWS::AccountId}/*'), Condition: { StringEquals: { 'aws:SourceArn': trailArn, 's3:x-amz-acl': 'bucket-owner-full-control' } } },
      { Sid: 'AccessLogWrite', Effect: 'Allow', Principal: { Service: 'logging.s3.amazonaws.com' }, Action: 's3:PutObject', Resource: sub('${AuditBucket.Arn}/access/*'), Condition: { StringEquals: { 'aws:SourceAccount': ref('AWS::AccountId') }, ArnEquals: { 'aws:SourceArn': [att('ArtifactBucket', 'Arn'), att('BackupBucket', 'Arn')] } } },
    ] } }, 'Allow only this stack trail and bucket access logs, with confused-deputy constraints.'),
    ArtifactPolicy: resource('AWS::S3::BucketPolicy', { Bucket: ref('ArtifactBucket'), PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [att('ArtifactBucket', 'Arn'), sub('${ArtifactBucket.Arn}/*')], Condition: { Bool: { 'aws:SecureTransport': 'false' } } }] } }, 'Private software bundles never share the public CDN bucket.'),
    BackupPolicy: resource('AWS::S3::BucketPolicy', { Bucket: ref('BackupBucket'), PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [att('BackupBucket', 'Arn'), sub('${BackupBucket.Arn}/*')], Condition: { Bool: { 'aws:SecureTransport': 'false' } } }] } }, 'Team state has no public access path.'),
    AuditTrail: resource('AWS::CloudTrail::Trail', { TrailName: ref('AWS::StackName'), IsLogging: true, IsMultiRegionTrail: false, IncludeGlobalServiceEvents: false, EnableLogFileValidation: true, KMSKeyId: att('DataKey', 'Arn'), S3BucketName: ref('AuditBucket'), S3KeyPrefix: 'trail', AdvancedEventSelectors: [
      { Name: 'PrivateRelayObjects', FieldSelectors: [{ Field: 'eventCategory', Equals: ['Data'] }, { Field: 'resources.type', Equals: ['AWS::S3::Object'] }, { Field: 'resources.ARN', StartsWith: [sub('${ArtifactBucket.Arn}/'), sub('${BackupBucket.Arn}/')] }] },
    ] }, 'Integrity-checked data events only for this stack buckets; unrelated account management writes are excluded.', ['Never log signed identity tokens or private admin capabilities.'], { DependsOn: 'AuditPolicy' }),
    RuntimeRole: resource('AWS::IAM::Role', { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] }, ManagedPolicyArns: [sub('arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore')], Policies: [{ PolicyName: 'PrivateRelayStorage', PolicyDocument: { Version: '2012-10-17', Statement: [
      { Sid: 'NoParameterStoreReads', Effect: 'Deny', Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'], Resource: '*' },
      { Effect: 'Allow', Action: 's3:GetObject', Resource: sub('${ArtifactBucket.Arn}/bundles/*') },
      { Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: sub('${BackupBucket.Arn}/snapshots/*') },
      { Effect: 'Allow', Action: 's3:ListBucket', Resource: att('BackupBucket', 'Arn'), Condition: { StringLike: { 's3:prefix': 'snapshots/*' } } },
      { Effect: 'Allow', Action: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'], Resource: att('DataKey', 'Arn') },
    ] } }] }, 'Instance role provides temporary storage and SSM access; no permanent keys.'),
    InstanceProfile: resource('AWS::IAM::InstanceProfile', { Roles: [ref('RuntimeRole')] }, 'Attach only the new scoped runtime role.'),
    DataVolume: resource('AWS::EC2::Volume', { AvailabilityZone: ref('AvailabilityZone'), Encrypted: true, KmsKeyId: att('DataKey', 'Arn'), Size: 16, VolumeType: 'gp3', Tags: [{ Key: 'Name', Value: sub('${AWS::StackName}-private-state') }] }, 'Retained volume preserves private journals and ACME state when the host is replaced.', ['Do not format an existing filesystem; bootstrap identifies this exact volume.'], retained),
    Host: resource('AWS::EC2::Instance', { ImageId: ref('UbuntuImage'), InstanceType: 't4g.small', AvailabilityZone: ref('AvailabilityZone'), IamInstanceProfile: ref('InstanceProfile'), SubnetId: ref('Subnet'), SecurityGroupIds: [ref('SecurityGroup')], CreditSpecification: { CPUCredits: 'standard' }, MetadataOptions: { HttpTokens: 'required', HttpEndpoint: 'enabled', HttpPutResponseHopLimit: 1, InstanceMetadataTags: 'disabled' }, BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { Encrypted: true, VolumeSize: 8, VolumeType: 'gp3', DeleteOnTermination: true } }], UserData: { 'Fn::Base64': { 'Fn::Join': ['', parts] } }, Tags: [{ Key: 'Name', Value: sub('${AWS::StackName}-host') }, { Key: 'Product', Value: 'MemCode' }, { Key: 'DataClass', Value: 'PrivateTeamPlanning' }] }, 'Single small pilot host: standard credits cap surplus CPU charges; no SSH key or public source checkout.', ['No worker, graph, user repository or permanent credential on this host.'], { DependsOn: ['Route', 'AuditTrail'] }),
    DataAttachment: resource('AWS::EC2::VolumeAttachment', { Device: '/dev/sdf', InstanceId: ref('Host'), VolumeId: ref('DataVolume') }, 'Keep retained private data separate from replaceable operating-system disk.'),
    PublicAddress: resource('AWS::EC2::EIP', { Domain: 'vpc' }, 'One stable public address for the new TLS hostname.', [], { DependsOn: 'GatewayAttachment' }),
    AddressAttachment: resource('AWS::EC2::EIPAssociation', { AllocationId: att('PublicAddress', 'AllocationId'), InstanceId: ref('Host') }, 'Attach only the new host and address.'),
    DNS: resource('AWS::Route53::RecordSet', { HostedZoneId: ref('HostedZoneId'), Name: ref('RelayHostname'), Type: 'A', TTL: '60', ResourceRecords: [ref('PublicAddress')] }, 'Create only the new team-service DNS record; do not modify existing application records.'),
    HostRecovery: resource('AWS::CloudWatch::Alarm', { AlarmDescription: 'Recover the dedicated beta host on an AWS system status failure', Namespace: 'AWS/EC2', MetricName: 'StatusCheckFailed_System', Dimensions: [{ Name: 'InstanceId', Value: ref('Host') }], Statistic: 'Maximum', Period: 60, EvaluationPeriods: 2, Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'missing', AlarmActions: [sub('arn:${AWS::Partition}:automate:${AWS::Region}:ec2:recover')] }, 'Automatic host recovery preserves its attached private volume and address.'),
  },
  Outputs: {
    ServiceURL: { Description: 'Publish discovery only after HTTPS and authenticated API acceptance passes.', Value: sub('https://${RelayHostname}') },
    InstanceId: { Description: 'New SSM-managed pilot host only.', Value: ref('Host') },
    PrivateArtifactBucket: { Description: 'Private reviewed software bundles; never a public release bucket.', Value: ref('ArtifactBucket') },
    PrivateBackupBucket: { Description: 'Retained encrypted daily team snapshots, 30-day object retention.', Value: ref('BackupBucket') },
    PrivateDataVolume: { Description: 'Retained encrypted live state; never delete during host replacement.', Value: ref('DataVolume') },
  },
};
await writeFile(new URL('relay.template.json', directory), JSON.stringify(template, null, 2) + '\n');
console.log(`Generated ${fileURLToPath(new URL('relay.template.json', directory))} (${Object.keys(template.Resources).length} dedicated resources).`);
