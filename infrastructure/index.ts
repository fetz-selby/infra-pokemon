import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'

// Configuration
const config = new pulumi.Config()
const domain = config.get('domain') || 'sels-dev.click'
const branchName = config.get('branchName') || 'staging'
const region = config.get('aws:region') || 'eu-central-1'

// Use branch name as subdomain
const environment = branchName
const fullDomain = `${branchName}.${domain}`

// Create VPC for staging environment
const vpc = new aws.ec2.Vpc('staging-vpc', {
  cidrBlock: '10.0.0.0/16',
  enableDnsHostnames: true,
  enableDnsSupport: true,
  tags: {
    Name: `beta-pokemon-vpc-${environment}`,
    Environment: environment,
  },
})

// Create Internet Gateway
const igw = new aws.ec2.InternetGateway('staging-igw', {
  vpcId: vpc.id,
  tags: {
    Name: `beta-pokemon-igw-${environment}`,
    Environment: environment,
  },
}, {
  import: 'igw-0e961853d25aa97ed',
})

// Create public subnets in different AZs for eu-central-1
const publicSubnet1 = new aws.ec2.Subnet('staging-public-subnet-1', {
  vpcId: vpc.id,
  cidrBlock: '10.0.1.0/24',
  availabilityZone: `${region}a`,
  mapPublicIpOnLaunch: true,
  tags: {
    Name: `beta-pokemon-public-subnet-1-${environment}`,
    Environment: environment,
  },
}, {
  import: 'subnet-0bad0184889d4aaf7',
})

const publicSubnet2 = new aws.ec2.Subnet('staging-public-subnet-2', {
  vpcId: vpc.id,
  cidrBlock: '10.0.2.0/24',
  availabilityZone: `${region}b`,
  mapPublicIpOnLaunch: true,
  tags: {
    Name: `beta-pokemon-public-subnet-2-${environment}`,
    Environment: environment,
  },
}, {
  import: 'subnet-0e81fc3c332dbe123',
})

// Create route table for public subnets
const publicRouteTable = new aws.ec2.RouteTable('staging-public-rt', {
  vpcId: vpc.id,
  routes: [
    {
      cidrBlock: '0.0.0.0/0',
      gatewayId: igw.id,
    },
  ],
  tags: {
    Name: `beta-pokemon-public-rt-${environment}`,
    Environment: environment,
  },
})

// Associate route table with public subnets
new aws.ec2.RouteTableAssociation('staging-public-rt-association-1', {
  subnetId: publicSubnet1.id,
  routeTableId: publicRouteTable.id,
})

new aws.ec2.RouteTableAssociation('staging-public-rt-association-2', {
  subnetId: publicSubnet2.id,
  routeTableId: publicRouteTable.id,
})

// Create security group for ALB
const albSecurityGroup = new aws.ec2.SecurityGroup('staging-alb-sg', {
  vpcId: vpc.id,
  description: 'Security group for staging ALB',
  ingress: [
    {
      fromPort: 80,
      toPort: 80,
      protocol: 'tcp',
      cidrBlocks: ['0.0.0.0/0'],
    },
    {
      fromPort: 443,
      toPort: 443,
      protocol: 'tcp',
      cidrBlocks: ['0.0.0.0/0'],
    },
  ],
  egress: [
    {
      fromPort: 0,
      toPort: 0,
      protocol: '-1',
      cidrBlocks: ['0.0.0.0/0'],
    },
  ],
  tags: {
    Name: `beta-pokemon-alb-sg-${environment}`,
    Environment: environment,
  },
})

// Create security group for ECS tasks
const ecsSecurityGroup = new aws.ec2.SecurityGroup('staging-ecs-sg', {
  vpcId: vpc.id,
  description: 'Security group for staging ECS tasks',
  ingress: [
    {
      fromPort: 3000,
      toPort: 3000,
      protocol: 'tcp',
      cidrBlocks: ['0.0.0.0/0'],
      securityGroups: [albSecurityGroup.id],
    },
  ],
  egress: [
    {
      fromPort: 0,
      toPort: 0,
      protocol: '-1',
      cidrBlocks: ['0.0.0.0/0'],
    },
  ],
  tags: {
    Name: `beta-pokemon-ecs-sg-${environment}`,
    Environment: environment,
  },
})

// Create Application Load Balancer
const alb = new aws.lb.LoadBalancer('staging-alb', {
  name: `beta-pokemon-alb-${environment}`,
  loadBalancerType: 'application',
  securityGroups: [albSecurityGroup.id],
  subnets: [publicSubnet1.id, publicSubnet2.id],
  enableDeletionProtection: false,
  tags: {
    Name: `beta-pokemon-alb-${environment}`,
    Environment: environment,
  },
})

// Create target group for ECS service
const targetGroup = new aws.lb.TargetGroup('staging-target-group', {
  name: `beta-pokemon-tg-${environment}`,
  port: 3000,
  protocol: 'HTTP',
  vpcId: vpc.id,
  targetType: 'ip',
  healthCheck: {
    enabled: true,
    healthyThreshold: 2,
    interval: 30,
    matcher: '200',
    path: '/',
    port: 'traffic-port',
    protocol: 'HTTP',
    timeout: 5,
    unhealthyThreshold: 2,
  },
  tags: {
    Name: `beta-pokemon-tg-${environment}`,
    Environment: environment,
  },
})

// Get Route 53 hosted zone
const hostedZone = aws.route53.getZone({
  name: domain,
  privateZone: false,
})

// Create ACM certificate for the branch domain
const certificate = new aws.acm.Certificate('staging-cert', {
  domainName: fullDomain,
  validationMethod: 'DNS',
  tags: {
    Name: fullDomain,
    Environment: environment,
  },
})

// Create Route 53 records for certificate validation
const certValidationRecords = certificate.domainValidationOptions.apply(
  (options) => {
    return options.map((option, index) => {
      return new aws.route53.Record(`staging-cert-validation-${index}`, {
        allowOverwrite: true,
        name: option.resourceRecordName,
        records: [option.resourceRecordValue],
        ttl: 60,
        type: option.resourceRecordType,
        zoneId: hostedZone.then((hz) => hz.zoneId),
      })
    })
  }
)

// Certificate validation
const certValidation = new aws.acm.CertificateValidation(
  'staging-cert-validation',
  {
    certificateArn: certificate.arn,
    validationRecordFqdns: certValidationRecords.apply((records) =>
      records.map((record) => record.fqdn)
    ),
  }
)

// Create HTTPS listener for ALB
const httpsListener = new aws.lb.Listener('staging-https-listener', {
  loadBalancerArn: alb.arn,
  port: 443,
  protocol: 'HTTPS',
  sslPolicy: 'ELBSecurityPolicy-TLS-1-2-2017-01',
  certificateArn: certValidation.certificateArn,
  defaultActions: [
    {
      type: 'forward',
      targetGroupArn: targetGroup.arn,
    },
  ],
})

// Create HTTP listener that redirects to HTTPS
const httpListener = new aws.lb.Listener('staging-http-listener', {
  loadBalancerArn: alb.arn,
  port: 80,
  protocol: 'HTTP',
  defaultActions: [
    {
      type: 'redirect',
      redirect: {
        port: '443',
        protocol: 'HTTPS',
        statusCode: 'HTTP_301',
      },
    },
  ],
})

// Create Route 53 record for branch subdomain
new aws.route53.Record('branch-record', {
  zoneId: hostedZone.then((hz) => hz.zoneId),
  name: fullDomain,
  type: 'A',
  aliases: [
    {
      name: alb.dnsName,
      zoneId: alb.zoneId,
      evaluateTargetHealth: true,
    },
  ],
})

// Create ECR repository for staging
const ecrRepository = new aws.ecr.Repository('staging-ecr', {
  name: `beta-pokemon-${environment}`,
  imageTagMutability: 'MUTABLE',
  imageScanningConfiguration: {
    scanOnPush: true,
  },
  encryptionConfigurations: [
    {
      encryptionType: 'AES256',
    },
  ],
})

// Create ECS cluster for staging
const ecsCluster = new aws.ecs.Cluster('staging-cluster', {
  name: `beta-pokemon-${environment}`,
  settings: [
    {
      name: 'containerInsights',
      value: 'enabled',
    },
  ],
})

// Create IAM role for ECS task execution
const ecsTaskExecutionRole = new aws.iam.Role(
  'staging-ecs-task-execution-role',
  {
    assumeRolePolicy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: {
            Service: 'ecs-tasks.amazonaws.com',
          },
        },
      ],
    }),
  }
)

// Attach the ECS task execution role policy
new aws.iam.RolePolicyAttachment('staging-ecs-task-execution-role-policy', {
  role: ecsTaskExecutionRole.name,
  policyArn:
    'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
})

// Create CloudWatch log group
const logGroup = new aws.cloudwatch.LogGroup('staging-log-group', {
  name: `/ecs/beta-pokemon-${environment}`,
  retentionInDays: 7,
})

// Create ECS task definition
const ecsTaskDefinition = new aws.ecs.TaskDefinition('staging-task', {
  family: `beta-pokemon-${environment}`,
  networkMode: 'awsvpc',
  requiresCompatibilities: ['FARGATE'],
  cpu: '256',
  memory: '512',
  executionRoleArn: ecsTaskExecutionRole.arn,
  containerDefinitions: pulumi.interpolate`[
        {
            "name": "beta-pokemon-app",
            "image": "${ecrRepository.repositoryUrl}:latest",
            "essential": true,
            "portMappings": [
                {
                    "containerPort": 3000,
                    "protocol": "tcp"
                }
            ],
            "logConfiguration": {
                "logDriver": "awslogs",
                "options": {
                    "awslogs-group": "${logGroup.name}",
                    "awslogs-region": "${region}",
                    "awslogs-stream-prefix": "ecs"
                }
            },
            "environment": [
                {
                    "name": "NODE_ENV",
                    "value": "${environment}"
                }
            ]
        }
    ]`,
})

// Create ECS service
const ecsService = new aws.ecs.Service(
  'staging-service',
  {
    cluster: ecsCluster.id,
    taskDefinition: ecsTaskDefinition.arn,
    launchType: 'FARGATE',
    desiredCount: 1,
    networkConfiguration: {
      subnets: [publicSubnet1.id, publicSubnet2.id],
      securityGroups: [ecsSecurityGroup.id],
      assignPublicIp: true,
    },
    loadBalancers: [
      {
        targetGroupArn: targetGroup.arn,
        containerName: 'beta-pokemon-app',
        containerPort: 3000,
      },
    ],
    deploymentMaximumPercent: 200,
    deploymentMinimumHealthyPercent: 50,
  },
  { dependsOn: [httpsListener, httpListener] }
)

// Export important values
export const vpcId = vpc.id
export const albArn = alb.arn
export const albDnsName = alb.dnsName
export const targetGroupArn = targetGroup.arn
export const appUrl = `https://${fullDomain}`
export const certificateArn = certificate.arn
export const ecrRepositoryUrl = ecrRepository.repositoryUrl
export const ecrRepositoryName = ecrRepository.name
export const ecsClusterName = ecsCluster.name
export const ecsServiceName = ecsService.name
