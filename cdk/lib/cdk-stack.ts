import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as apigateway from '@aws-cdk/aws-apigatewayv2-alpha';
import { HttpLambdaIntegration } from '@aws-cdk/aws-apigatewayv2-integrations-alpha';
import { HttpIamAuthorizer } from '@aws-cdk/aws-apigatewayv2-authorizers-alpha';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';
import { KubectlV26Layer } from '@aws-cdk/lambda-layer-kubectl-v26';
import * as s3Assets from 'aws-cdk-lib/aws-s3-assets';
import * as kms from 'aws-cdk-lib/aws-kms';

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ddbEncryptionKey = new kms.Key(this, 'DDBEncryptionKey', {
      enabled: true,
    });

    const codecommitPATPatTable = new dynamodb.Table(this, 'CodeCommitPATPatTable', {
      partitionKey: { name: 'token', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      tableName: "CodeCommitPATPatTable",
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: ddbEncryptionKey
    });

    codecommitPATPatTable.addGlobalSecondaryIndex({
      indexName: 'repoIDIndex',
      partitionKey: {
        name: 'repoID',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'username',
        type: dynamodb.AttributeType.STRING,
      },
    });

    //This will create the VPC with private subnets for the EKS nodes and the public for EKS control pane?
    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName:'CodeCommitPATVPC',
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PrivateSubnet1',
          subnetType:ec2.SubnetType.PRIVATE_WITH_EGRESS
        },
        {
          cidrMask: 24,
          name: 'PrivateSubnet2',
          subnetType:ec2.SubnetType.PRIVATE_WITH_EGRESS
        },
        {
          cidrMask: 24,
          name: 'PublicSubnet',
          subnetType:ec2.SubnetType.PUBLIC
        },
      ]
    });

    NagSuppressions.addResourceSuppressions(vpc, [
      { id: 'AwsSolutions-VPC7', reason: 'VPC is used for demo purposes only. Will not be used in Production.' },
    ]);

    // This role is built using the permissions from the Admin role ARN
    // Set 'mutable' to 'false' to use the role as-is and prevent adding new policies to it.
    const mastersRole = iam.Role.fromRoleArn(this, 'Role', 'arn:aws:iam::'+process.env.CDK_DEFAULT_ACCOUNT+':role/Admin', {
      mutable: false,
    });

    //This will create the EKS cluster with masters RBAC role using the private subnets
    const codecommitPATEKSCluster = new eks.Cluster(this, 'CodeCommitPATEKS', {
      clusterName:'CodeCommitPATEKS',
      version: eks.KubernetesVersion.V1_26,
      mastersRole: mastersRole,
      kubectlLayer: new KubectlV26Layer(this, 'kubectl'),
      defaultCapacity: 0,
      outputClusterName:true,
      outputMastersRoleArn:true,
      vpc: vpc,
      vpcSubnets: [{subnetGroupName:'PrivateSubnet1'},{subnetGroupName:'PrivateSubnet2'} ]
    });

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [
        '/CdkStack/CodeCommitPATEKS/Role/Resource',
        '/CdkStack/CodeCommitPATEKS/Resource/CreationRole/DefaultPolicy/Resource',
        '/CdkStack/CodeCommitPATEKS/Resource/Resource/Default'
      ],
      [
        { id: 'AwsSolutions-IAM4', reason: 'Utilizing default policy for cluster creation.' },
        { id: 'AwsSolutions-IAM5', reason: 'Utilizing default policy for cluster creation.' },
        { id: 'AwsSolutions-EKS1', reason: 'EKS Cluster is for demo purposes, and will not be utilized in production. Need public access for demo.' },
        { id: 'AwsSolutions-EKS2', reason: 'EKS Cluster is for demo purposes, and will not be utilized in production. No need for logging.' },
      ]
    );

    const patProxyNamespace = codecommitPATEKSCluster.addManifest('PatProxyNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'patproxy' },
    });

    //this will handle the IRSA role assignement to the cluster
    //Here we will configure the service account access
    const serviceAccount = codecommitPATEKSCluster.addServiceAccount('IRSAServiceAccount', {
      name: 'iamserviceaccount',
      namespace: "patproxy",
    });
    
    serviceAccount.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        //Dynamo Permissions
        "dynamodb:PutItem",
        "dynamodb:DeleteItem",
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:UpdateItem",
        //Codecommit Permissions
        "codecommit:GitPull",
        "codecommit:GitPush",
        //KMS Permissions
        "kms:Decrypt",
        "kms:Encrypt",
        "kms:GenerateDataKey"
      ],
      resources: [
        //DynamoDB Resources
        codecommitPATPatTable.tableArn,
        codecommitPATPatTable.tableArn+"/index/repoIDIndex",
        //Codecommit Resources
        "arn:aws:codecommit:"+process.env.CDK_DEFAULT_REGION+":"+process.env.CDK_DEFAULT_ACCOUNT+":*",
        //KMS Resources
        ddbEncryptionKey.keyArn,
      ]
    }));

    //this will create the NodeGroup in the cluster
    const codecommitPATEKSClusterNodeGroup = new eks.Nodegroup(this, 'CodeCommitPATEKSClusterNodeGroup', {
      nodegroupName: "CodeCommitPATEKSClusterNodeGroup",
      cluster: codecommitPATEKSCluster,
      minSize: 4,
      maxSize: 4,
      instanceTypes: [
        ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.XLARGE),
      ]
    });

    const request = require('sync-request');

    // install AWS load balancer via Helm charts
    const awsLoadBalancerControllerVersion = 'v2.5.4';
    const awsControllerBaseResourceBaseUrl = `https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/${awsLoadBalancerControllerVersion}/docs`;
    const awsControllerPolicyUrl = `${awsControllerBaseResourceBaseUrl}/install/iam_policy.json`;
    const albNamespace = 'kube-system';

    const albServiceAccount = codecommitPATEKSCluster.addServiceAccount('aws-load-balancer-controller', {
      name: 'aws-load-balancer-controller',
      namespace: albNamespace,
    });

    const policyJson = request('GET', awsControllerPolicyUrl).getBody();
    ((JSON.parse(policyJson)).Statement as []).forEach((statement, _idx, _array) => {
      albServiceAccount.addToPrincipalPolicy(iam.PolicyStatement.fromJson(statement));
    });

    const awsLoadBalancerControllerChart = codecommitPATEKSCluster.addHelmChart('AWSLoadBalancerController', {
      chart: 'aws-load-balancer-controller',
      repository: 'https://aws.github.io/eks-charts',
      namespace: albNamespace,
      release: 'aws-load-balancer-controller',
      version: '1.5.5', // mapping to v2.5.4
      wait: true,
      timeout: cdk.Duration.minutes(15),
      values: {
        clusterName: codecommitPATEKSCluster.clusterName,
        image: {
          repository: "public.ecr.aws/eks/aws-load-balancer-controller",
        },
        serviceAccount: {
          create: false,
          name: albServiceAccount.serviceAccountName,
        },
        // must disable waf features for aws-cn partition
        enableShield: false,
        enableWaf: false,
        enableWafv2: false,
      },
    });
    awsLoadBalancerControllerChart.node.addDependency(codecommitPATEKSClusterNodeGroup);
    awsLoadBalancerControllerChart.node.addDependency(albServiceAccount);
    awsLoadBalancerControllerChart.node.addDependency(codecommitPATEKSCluster.openIdConnectProvider);
    awsLoadBalancerControllerChart.node.addDependency(codecommitPATEKSCluster.awsAuth);

    const certManagerNamespace = "cert-manager";

    const certManagerChart = codecommitPATEKSCluster.addHelmChart('CertManagerChart', {
      chart: 'cert-manager',
      repository: 'https://charts.jetstack.io',
      namespace: certManagerNamespace,
      release: 'cert-manager',
      version: 'v1.12.0',
      wait: true,
      timeout: cdk.Duration.minutes(15),
      values: {
        "installCRDs": true
      }
    });

    const codecommitPATRepository = new ecr.Repository(this, 'CodeCommitPATRepository', {
      repositoryName: "patproxy"
    });

    new cdk.CfnOutput(this, 'ECRRepoURI', { value: codecommitPATRepository.repositoryUri });

    const managementLambda = new lambda.NodejsFunction(this, 'ManagementLambda', {
      entry: path.resolve(__dirname, '../app/managementLambda/index.ts'),
      handler: 'handler',
      memorySize: 1028,
      environment: {
        "TABLENAME": codecommitPATPatTable.tableName,
        "KMSKEYID": ddbEncryptionKey.keyId,
      },
      initialPolicy: [
        new iam.PolicyStatement({ 
          actions: [
            "dynamodb:PutItem",
            "dynamodb:GetItem",
            "dynamodb:Query",
            "dynamodb:DeleteItem",
            "kms:Decrypt",
            "kms:Encrypt",
            "kms:GenerateDataKey"
          ],
          resources: [
            codecommitPATPatTable.tableArn,
            codecommitPATPatTable.tableArn+"/index/repoIDIndex",
            ddbEncryptionKey.keyArn,
          ],
        }),
      ],
      bundling: {
        minify: true, // minify code, defaults to false
        sourceMap: true, // include source map, defaults to false
        sourceMapMode: lambda.SourceMapMode.INLINE, // defaults to SourceMapMode.DEFAULT
        sourcesContent: false, // do not include original source into source map, defaults to true
        target: 'es2020', // target environment for the generated JavaScript code
      }
    });

    const managementLambdaIntegration = new HttpLambdaIntegration('ManagementLambdaIntegration', managementLambda);
    const managementLambdaAuthorizer = new HttpIamAuthorizer();

    const ManagementAPIGatewayIntegration = new apigateway.HttpApi(this, 'ManagementAPIGatewayIntegration', {
      defaultAuthorizer: managementLambdaAuthorizer
    });

    new cdk.CfnOutput(this, 'APIGATEWAYURL', { value: ManagementAPIGatewayIntegration.apiEndpoint });

    ManagementAPIGatewayIntegration.addRoutes({
      path: '/{proxy+}',
      methods: [ apigateway.HttpMethod.POST, apigateway.HttpMethod.GET ],
      integration: managementLambdaIntegration,
    });

    const benchmarkAsset = new s3Assets.Asset(this, 'benchmarkAsset', {
      path: path.join(__dirname, '../../benchmark'),
    });

    const benchmarkInstanceKeyPair = new ec2.CfnKeyPair(this, 'benchmarkInstanceKeyPair', {
      keyName: 'benchmarkInstanceKeyPair',
    });

    const benchmarkPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: ['arn:aws:s3:::'+benchmarkAsset.s3BucketName+'/'+benchmarkAsset.s3ObjectKey],
        }),
        new iam.PolicyStatement({
          actions: ['execute-api:Invoke'],
          resources: ['arn:aws:execute-api:'+process.env.CDK_DEFAULT_REGION+':'+process.env.CDK_DEFAULT_ACCOUNT+':'+ManagementAPIGatewayIntegration.apiId+'/*/POST/*'],
        }),
      ],
    });

    const benchmarkRole = new iam.Role(this, 'benchmarkRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Allow EC2 to copy benchmark asset files.',
      inlinePolicies: {
        BenchmarkPolicy: benchmarkPolicy,
      },
    });

    benchmarkRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchAgentServerPolicy"));

    const defaultVpc = ec2.Vpc.fromLookup(this, 'DefaultVPC', { isDefault: true });

    const benchmarkSG = new ec2.SecurityGroup(this, 'benchmarkSG', {
      vpc: defaultVpc,
      allowAllOutbound: true,
      description: 'Security group for benchmarking instance',
    });

    benchmarkSG.addIngressRule(
      ec2.Peer.prefixList("pl-4e2ece27"),
      ec2.Port.tcp(22),
      'allow SSH access from Prefix list',
    );	

    const benchmarkInstance = new ec2.Instance(this, 'benchmarkInstance', {
      vpc: defaultVpc,
      securityGroup: benchmarkSG,
      associatePublicIpAddress: true,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.XLARGE4),
      machineImage: ec2.MachineImage.latestAmazonLinux2(),
      role: benchmarkRole,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      keyName: 'benchmarkInstanceKeyPair',
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(50, {
            encrypted: true,
          }),
        }
      ]
    });

    benchmarkInstance.addUserData(`
      su - ec2-user
      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.3/install.sh | bash
      . ~/.nvm/nvm.sh
      nvm install --lts
      sudo yum install nodejs npm --enablerepo=epel -y
      aws s3 cp `+benchmarkAsset.s3ObjectUrl+` /home/ec2-user/
      mkdir /home/ec2-user/benchmark/
      unzip /home/ec2-user/`+benchmarkAsset.s3ObjectKey+` -d /home/ec2-user/benchmark/
      cd /home/ec2-user/benchmark/
      npm install --yes
      chmod +x /home/ec2-user/benchmark/k6
    `);

    new cdk.CfnOutput(this, 'BenchmarkInstanceHostname', { value: benchmarkInstance.instancePublicDnsName });

  }
}
